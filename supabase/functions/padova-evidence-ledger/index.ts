// padova-evidence-ledger
// POST ?action=rebuild   -> costruisce evidenze per opportunita Padova attive
// POST ?action=rescore   -> applica regole FASE 2 e aggiorna confidence
// GET  ?action=report    -> output FASE 5

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

type GeoLevel = "exact_address" | "street" | "microzone" | "district" | "city_level";
type Role = "anticipatory" | "confirmation" | "context";

interface RegistryRow {
  source_name: string;
  default_geo_level: GeoLevel;
  default_weight: number;
  default_anticipatory: Role;
  privacy_class: string;
  priority_rank: number;
}

const STRONG_LEGAL = new Set(["pvp", "tribunale_padova", "comune_padova_avvisi"]);

function svc() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "X-Core-Function": "padova-evidence-ledger" },
  });
}

async function sha1(s: string): Promise<string> {
  const b = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest("SHA-1", b);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function inferGeoLevel(
  reg: RegistryRow | undefined,
  payload: Record<string, unknown>,
  microzona: string | null,
  url: string,
): GeoLevel {
  if (reg) return reg.default_geo_level;
  // fallback: se url contiene indizio civico → street
  if (/via |viale |corso |piazza /i.test(url)) return "street";
  if (microzona) return "microzone";
  return "city_level";
}

async function actionRebuild(supa: ReturnType<typeof svc>) {
  const warnings: string[] = [];
  const { data: opps, error } = await supa
    .from("early_warning_opportunities")
    .select("id,comune,microzona,area_label,signal_types,source_names,source_urls,payload,detected_at,primary_signal_type")
    .eq("is_active", true)
    .ilike("comune", "padova");
  if (error) return { error: error.message };

  const { data: regRows } = await supa.from("evidence_source_registry").select("*");
  const reg = new Map<string, RegistryRow>();
  (regRows ?? []).forEach((r: RegistryRow) => reg.set(r.source_name, r));

  let inserted = 0;
  let skipped_no_url = 0;
  const rows: Array<Record<string, unknown>> = [];

  for (const o of opps ?? []) {
    const names: string[] = o.source_names ?? [];
    const urls: string[] = o.source_urls ?? [];
    const payload = (o.payload ?? {}) as Record<string, unknown>;
    const sigTypes: string[] = o.signal_types ?? [];
    const microzona: string | null = o.microzona ?? null;
    const detected = o.detected_at as string;
    const freshness = detected ? Math.max(0, Math.round((Date.now() - new Date(detected).getTime()) / 86_400_000)) : null;

    for (let i = 0; i < names.length; i++) {
      const src = names[i];
      const url = urls[i] || (urls.length === 1 ? urls[0] : "");
      if (!url) { skipped_no_url++; warnings.push(`opp ${o.id}: source ${src} senza url, esclusa`); continue; }
      const r = reg.get(src);
      const geo = inferGeoLevel(r, payload, microzona, url);
      const role: Role = r?.default_anticipatory ?? "context";
      let weight = r?.default_weight ?? 0.2;
      // demotion city-level se segnale forte ma fonte aggregata
      if (geo === "city_level" && (sigTypes.includes("AUCTION_CONFIRMATION") || sigTypes.includes("LISTING_VOLUME"))) {
        weight = Math.min(weight, 0.3);
      }
      const signalType = sigTypes[i] ?? sigTypes[0] ?? (o.primary_signal_type as string) ?? "UNKNOWN";
      const reason = r
        ? `registry: ${r.default_geo_level}/${r.default_anticipatory}/peso ${r.default_weight}`
        : `fonte non in registry, assegnato fallback ${geo}/peso ${weight}`;
      const fp = await sha1(`${o.id}|${src}|${url}|${signalType}`);
      rows.push({
        opportunity_id: o.id,
        opportunity_table: "early_warning_opportunities",
        source_name: src,
        source_url: url,
        geo_level: geo,
        signal_type: signalType,
        freshness_days: freshness,
        anticipatory_or_confirmation: role,
        score_weight: weight,
        privacy_safe: r?.privacy_class !== "sensitive" && r?.privacy_class !== "forbidden",
        reason_for_weight: reason,
        area_match: {
          comune: o.comune,
          microzona,
          area_label: o.area_label,
          omi_zone: payload.omi_zone ?? null,
          civico: payload.civico ?? null,
        },
        fingerprint: fp,
      });
    }
  }

  if (rows.length > 0) {
    const { error: insErr, count } = await supa
      .from("opportunity_evidence")
      .upsert(rows, { onConflict: "fingerprint", count: "exact" });
    if (insErr) return { error: insErr.message, warnings };
    inserted = count ?? rows.length;
  }

  return {
    ok: true,
    opportunities_processed: opps?.length ?? 0,
    evidences_upserted: inserted,
    skipped_no_url,
    warnings,
  };
}

async function actionRescore(supa: ReturnType<typeof svc>) {
  const { data: opps } = await supa
    .from("early_warning_opportunities")
    .select("id,confidence,area_label,microzona")
    .eq("is_active", true)
    .ilike("comune", "padova");

  const updates: Array<{ id: number; new_confidence: string; old_confidence: string; reason: string }> = [];
  for (const o of opps ?? []) {
    const { data: evs } = await supa
      .from("opportunity_evidence")
      .select("source_name,geo_level,source_url,anticipatory_or_confirmation")
      .eq("opportunity_id", o.id);
    const valid = (evs ?? []).filter((e) => e.source_url && e.source_url.length > 0);
    const micro = valid.filter((e) => e.geo_level === "microzone" || e.geo_level === "street" || e.geo_level === "exact_address");
    const cityOnly = valid.length > 0 && micro.length === 0;
    const strongLegal = valid.filter((e) => STRONG_LEGAL.has(e.source_name));

    let target: "high" | "media" | "bassa" = o.confidence as any;
    let reason = "invariata";

    // Distinct independent micro sources
    const microSources = new Set(micro.map((e) => e.source_name));
    if (microSources.size >= 2) {
      target = "high"; reason = `>=2 fonti microzone/street indipendenti (${[...microSources].join(",")})`;
    } else if (microSources.size >= 1 && strongLegal.length >= 1) {
      target = "high"; reason = `1 microzone/street + legale forte (${strongLegal.map((s) => s.source_name).join(",")})`;
    } else if (cityOnly) {
      target = "bassa"; reason = `solo evidenze city-level: declassata`;
    } else if (micro.length === 0 && valid.length > 0) {
      target = "bassa"; reason = `nessuna evidenza microzone/street`;
    } else {
      target = "media"; reason = `1 microzone/street senza secondo conferma`;
    }

    if (target !== o.confidence) {
      const { error } = await supa
        .from("early_warning_opportunities")
        .update({ confidence: target, updated_at: new Date().toISOString() })
        .eq("id", o.id);
      if (!error) updates.push({ id: o.id, old_confidence: o.confidence as string, new_confidence: target, reason });
    }
  }
  return { ok: true, updates_count: updates.length, updates };
}

async function actionReport(supa: ReturnType<typeof svc>) {
  const { data: opps } = await supa
    .from("early_warning_opportunities")
    .select("id,confidence,microzona,area_label,source_names")
    .eq("is_active", true)
    .ilike("comune", "padova");
  const oppIds = (opps ?? []).map((o) => o.id);
  const { data: evs } = await supa
    .from("opportunity_evidence")
    .select("opportunity_id,source_name,geo_level,source_url")
    .in("opportunity_id", oppIds.length ? oppIds : [-1]);

  const all = evs ?? [];
  const city = all.filter((e) => e.geo_level === "city_level").length;
  const micro = all.filter((e) => e.geo_level === "microzone" || e.geo_level === "street" || e.geo_level === "exact_address").length;
  const oppsWithLedger = new Set(all.map((e) => e.opportunity_id)).size;

  // Declassate (solo city-level)
  const byOpp = new Map<number, typeof all>();
  for (const e of all) {
    const arr = byOpp.get(e.opportunity_id) ?? [];
    arr.push(e); byOpp.set(e.opportunity_id, arr);
  }
  const declassate = [...byOpp.entries()].filter(([_id, list]) => list.every((e) => e.geo_level === "city_level")).length;
  const highReal = (opps ?? []).filter((o) => o.confidence === "high").length;

  // Top 5 microzone
  const microMap = new Map<string, { sources: Set<string>; geo_levels: Set<string>; count: number }>();
  for (const o of opps ?? []) {
    const key = o.microzona || o.area_label || "?";
    const evList = byOpp.get(o.id) ?? [];
    const m = microMap.get(key) ?? { sources: new Set(), geo_levels: new Set(), count: 0 };
    evList.forEach((e) => { m.sources.add(e.source_name); m.geo_levels.add(e.geo_level); });
    m.count += evList.length;
    microMap.set(key, m);
  }
  const topMicrozones = [...microMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([microzona, m]) => ({ microzona, sources: [...m.sources], geo_levels: [...m.geo_levels], evidences: m.count }));

  const microRatio = all.length > 0 ? micro / all.length : 0;
  const allHaveUrl = all.every((e) => !!e.source_url);

  // Civici Padova ingeriti?
  let haveCivici = false;
  try {
    const { count } = await supa.from("padova_civici").select("*", { count: "exact", head: true });
    haveCivici = (count ?? 0) > 0;
  } catch { haveCivici = false; }

  const gaps: string[] = [];
  if (!haveCivici) gaps.push("padova_civici non ingeriti (anchor priority 1 mancante)");
  if (microRatio < 0.4) gaps.push(`evidenze microzone/street solo ${Math.round(microRatio * 100)}% (target >=40%)`);
  if (highReal < 3) gaps.push(`high-confidence vere ${highReal} (target >=3 per 1.490€/mese)`);
  if (!allHaveUrl) gaps.push("alcune evidenze prive di source_url reale");
  if (!all.some((e) => STRONG_LEGAL.has(e.source_name))) gaps.push("nessuna fonte legale forte attribuita (PVP/Tribunale/Avvisi)");

  let stato: "DATA_PARTIAL" | "DATA_READY_FOR_1490_CONTROLLED_SALES" | "DATA_READY_FOR_PUBLIC_SALES" = "DATA_PARTIAL";
  if (highReal >= 3 && microRatio >= 0.4 && allHaveUrl) stato = "DATA_READY_FOR_1490_CONTROLLED_SALES";
  if (highReal >= 10 && microRatio >= 0.6 && haveCivici && allHaveUrl) stato = "DATA_READY_FOR_PUBLIC_SALES";

  return {
    ok: true,
    evidenze_totali: all.length,
    evidenze_city_level: city,
    evidenze_microzone_street_level: micro,
    opportunita_con_ledger: oppsWithLedger,
    opportunita_declassate_solo_city: declassate,
    opportunita_high_confidence_vere: highReal,
    top_microzone: topMicrozones,
    gaps_per_1490: gaps,
    stato,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "report";
  const supa = svc();
  try {
    if (action === "rebuild") return ok(await actionRebuild(supa));
    if (action === "rescore") return ok(await actionRescore(supa));
    if (action === "report") return ok(await actionReport(supa));
    return ok({ error: "unknown action" }, 400);
  } catch (e) {
    return ok({ error: String((e as Error).message ?? e) }, 500);
  }
});
