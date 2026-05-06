// ═══════════════════════════════════════════════════════════════
// agencyOffmarketBrief.ts — brief acquisitivo per area operativa.
// Solo dati DB già esistenti. Nessuno scraping. Nessun import.
// Esclude aste/alienazioni di default. Esclude segnali nominativi.
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  getAgencyOperatingContext, type OperatingAreaInput,
  type AgencySignalPreferences, isSignalAllowedByPreferences,
  resolveOperatingAreaInput,
} from "./agencyOperatingContext.ts";
// (compat trailing import line removed)
const __unused__ = 0;
import { isScriptSafeForSensitiveTurnover, buildNeutralZoneScript } from "../privacy/sensitiveTurnoverPolicy.ts";

function sb() {
  const url = Deno.env.get("SUPABASE_URL");
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !svc) throw new Error("supabase service role missing");
  return createClient(url, svc, { auth: { persistSession: false } });
}

export interface AgencyBriefBody extends OperatingAreaInput {
  dryRun?: boolean;
  import?: boolean;
  preferences?: Partial<AgencySignalPreferences>;
  excludeAuctions?: boolean;
  includePublicAlienations?: boolean;
  includeSensitiveTurnover?: boolean;
  includeSensitiveTurnoverAggregated?: boolean;
  topN?: number;
}

export async function runAgencyOffmarketBrief(body: AgencyBriefBody) {
  const dryRun = body.dryRun !== false;
  const topN = Math.min(Math.max(Number(body.topN ?? 10) || 10, 1), 50);

  const ctx = getAgencyOperatingContext({
    area: {
      province: body.province, comuni: body.comuni,
      microzones: body.microzones, quartieri: body.quartieri,
      focus: body.focus, radius_km: body.radius_km, label: body.label,
    },
    preferences: {
      ...(body.preferences ?? {}),
      ...(body.excludeAuctions !== undefined ? { exclude_auctions: !!body.excludeAuctions } : {}),
      ...(body.includePublicAlienations !== undefined ? { include_public_alienations: !!body.includePublicAlienations } : {}),
      ...(body.includeSensitiveTurnover !== undefined ? { include_sensitive_turnover: !!body.includeSensitiveTurnover } : { include_sensitive_turnover: false }),
      ...(body.includeSensitiveTurnoverAggregated !== undefined ? { include_sensitive_turnover_aggregated: !!body.includeSensitiveTurnoverAggregated } : { include_sensitive_turnover_aggregated: true }),
    },
  });

  if (ctx.needs_operating_area) {
    return {
      ok: false,
      needs_operating_area: true,
      message: "Specifica almeno province o comuni per definire l'area operativa.",
    };
  }

  const client = sb();
  const data_basis: string[] = [];
  const missing_data: string[] = [];
  const warnings: string[] = [];

  // 1) offmarket_opportunity_scores
  let oosQ = client.from("offmarket_opportunity_scores")
    .select("comune, provincia, area_label, area_type, off_market_potential_score, acquisition_priority_score, owner_education_score, microzone_heat_score, family_attractiveness_score, investor_attractiveness_score, exclusive_pitch_score, valuation_campaign_score, confidence_score, quality, positive_factors, negative_factors, missing_factors, recommended_actions, scripts, source_refs, is_active")
    .eq("is_active", true)
    .order("acquisition_priority_score", { ascending: false, nullsFirst: false })
    .limit(500);
  if (ctx.area.comuni.length) oosQ = oosQ.in("comune", ctx.area.comuni);
  else if (ctx.area.province.length) oosQ = oosQ.in("provincia", ctx.area.province);
  const { data: oos, error: oosErr } = await oosQ;
  if (oosErr) warnings.push(`offmarket_opportunity_scores: ${oosErr.message}`);
  if ((oos?.length ?? 0) > 0) data_basis.push("offmarket_opportunity_scores");
  else missing_data.push("offmarket_opportunity_scores");

  // 2) microzone_sentiment
  let msQ = client.from("microzone_sentiment")
    .select("comune, provincia, area_label, area_type, sentiment_score_total, family_fit_score, investor_fit_score, services_score, transit_access_score, green_score, environment_score, confidence_score, quality")
    .eq("is_active", true)
    .order("sentiment_score_total", { ascending: false, nullsFirst: false })
    .limit(300);
  if (ctx.area.comuni.length) msQ = msQ.in("comune", ctx.area.comuni);
  else if (ctx.area.province.length) msQ = msQ.in("provincia", ctx.area.province);
  const { data: ms } = await msQ;
  if ((ms?.length ?? 0) > 0) data_basis.push("microzone_sentiment"); else missing_data.push("microzone_sentiment");

  // 3) area_opportunity_scores
  let aosQ = client.from("area_opportunity_scores")
    .select("municipality, province, microzone, score, temperature, components, quality, computed_at")
    .order("score", { ascending: false, nullsFirst: false }).limit(300);
  if (ctx.area.comuni.length) aosQ = aosQ.in("municipality", ctx.area.comuni);
  else if (ctx.area.province.length) aosQ = aosQ.in("province", ctx.area.province);
  const { data: aos } = await aosQ;
  if ((aos?.length ?? 0) > 0) data_basis.push("area_opportunity_scores"); else missing_data.push("area_opportunity_scores");

  // 4) territorial_signals (filtrati per pref e area)
  let tsQ = client.from("territorial_signals")
    .select("municipality, province, signal_type, title, description, confidence_score, quality, payload, detected_at")
    .order("detected_at", { ascending: false }).limit(300);
  if (ctx.area.comuni.length) tsQ = tsQ.in("municipality", ctx.area.comuni);
  else if (ctx.area.province.length) tsQ = tsQ.in("province", ctx.area.province);
  const { data: ts } = await tsQ;
  const tsFiltered = (ts ?? []).filter((s: any) => isSignalAllowedByPreferences(s, ctx.preferences).allowed);
  if (tsFiltered.length > 0) data_basis.push("territorial_signals"); else missing_data.push("territorial_signals");

  // 5) radar_signals (filtrati)
  let rsQ = client.from("radar_signals")
    .select("municipality, province, signal_type, title, description, confidence, urgency, payload, detected_at")
    .eq("is_active", true)
    .order("detected_at", { ascending: false }).limit(300);
  if (ctx.area.comuni.length) rsQ = rsQ.in("municipality", ctx.area.comuni);
  else if (ctx.area.province.length) rsQ = rsQ.in("province", ctx.area.province);
  const { data: rs } = await rsQ;
  const rsFiltered = (rs ?? []).filter((s: any) => isSignalAllowedByPreferences(s, ctx.preferences).allowed);
  if (rsFiltered.length > 0) data_basis.push("radar_signals"); else missing_data.push("radar_signals");

  // ── Aggregazioni ──
  const byComune = new Map<string, { comune: string; provincia: string; signals: number; avgPriority: number; sumPriority: number; n: number }>();
  for (const r of oos ?? []) {
    const key = `${r.comune}|${r.provincia}`;
    const cur = byComune.get(key) ?? { comune: r.comune, provincia: r.provincia, signals: 0, avgPriority: 0, sumPriority: 0, n: 0 };
    cur.sumPriority += Number(r.acquisition_priority_score ?? 0);
    cur.n += 1;
    byComune.set(key, cur);
  }
  for (const cur of byComune.values()) cur.avgPriority = cur.n > 0 ? Math.round((cur.sumPriority / cur.n) * 10) / 10 : 0;
  const top_comuni = Array.from(byComune.values()).sort((a, b) => b.avgPriority - a.avgPriority).slice(0, topN);

  const top_microzones = (oos ?? [])
    .filter((r: any) => r.area_label)
    .sort((a: any, b: any) => Number(b.acquisition_priority_score ?? 0) - Number(a.acquisition_priority_score ?? 0))
    .slice(0, topN)
    .map((r: any) => ({
      comune: r.comune, provincia: r.provincia, area_label: r.area_label,
      acquisition_priority_score: r.acquisition_priority_score,
      microzone_heat_score: r.microzone_heat_score,
      confidence_score: r.confidence_score, quality: r.quality,
    }));

  const acquisition_opportunities = (oos ?? [])
    .sort((a: any, b: any) => Number(b.acquisition_priority_score ?? 0) - Number(a.acquisition_priority_score ?? 0))
    .slice(0, topN)
    .map((r: any) => ({
      comune: r.comune, provincia: r.provincia, area_label: r.area_label,
      headline: `Priorità acquisitiva alta in ${r.area_label ?? r.comune}`,
      why_now: (r.positive_factors ?? []).slice(0, 3),
      recommended_move: (r.recommended_actions ?? [])[0] ?? "Attivare campagna valutazione mirata sulla microzona.",
      owner_script: (r.scripts ?? [])[0] ?? null,
      data_points: {
        acquisition_priority_score: r.acquisition_priority_score,
        off_market_potential_score: r.off_market_potential_score,
        microzone_heat_score: r.microzone_heat_score,
      },
      confidence: r.confidence_score, quality: r.quality,
      source_refs: r.source_refs ?? [],
    }));

  const valuation_campaigns = (oos ?? [])
    .filter((r: any) => Number(r.valuation_campaign_score ?? 0) >= 50)
    .sort((a: any, b: any) => Number(b.valuation_campaign_score ?? 0) - Number(a.valuation_campaign_score ?? 0))
    .slice(0, topN)
    .map((r: any) => ({
      comune: r.comune, provincia: r.provincia, area_label: r.area_label,
      valuation_campaign_score: r.valuation_campaign_score,
      angle: "Aggiornamento report valori OMI + servizi locali per la zona.",
      confidence: r.confidence_score,
    }));

  const owner_education_angles = (oos ?? [])
    .filter((r: any) => Number(r.owner_education_score ?? 0) >= 40)
    .slice(0, topN)
    .map((r: any) => ({
      comune: r.comune, area_label: r.area_label,
      angle: "Spiegare ai proprietari come OMI, sentiment e servizi influenzano la valutazione.",
      owner_education_score: r.owner_education_score,
    }));



  // Sensitive turnover (aggregated only by default; nominative never used here)
  let turnover_aggregated_insights: any[] = [];
  let turnover_used = false;
  if (ctx.preferences.include_sensitive_turnover_aggregated) {
    let etzQ = client.from("estate_turnover_zones")
      .select("comune, provincia, area_label, microzona, score, temperature, reason, positive_factors, missing_factors, confidence_score, quality, category, agency_private_only, computed_at")
      .eq("is_active", true)
      .order("score", { ascending: false, nullsFirst: false })
      .limit(200);
    if (ctx.area.comuni.length) etzQ = etzQ.in("comune", ctx.area.comuni);
    else if (ctx.area.province.length) etzQ = etzQ.in("provincia", ctx.area.province);
    const { data: etz } = await etzQ;

    let ipsQ = client.from("inheritance_pressure_signals")
      .select("comune, provincia, area_label, area_type, score, confidence_score, quality, indicators, category, agency_private_only, computed_at")
      .eq("is_active", true)
      .order("score", { ascending: false, nullsFirst: false })
      .limit(200);
    if (ctx.area.comuni.length) ipsQ = ipsQ.in("comune", ctx.area.comuni);
    else if (ctx.area.province.length) ipsQ = ipsQ.in("provincia", ctx.area.province);
    const { data: ips } = await ipsQ;

    // Strictly aggregated rows (area_type aggregato OR area_label di zona). Nessun nominativo.
    const etzAgg = (etz ?? []).filter((r: any) => !!r.area_label).slice(0, topN).map((r: any) => ({
      kind: "estate_turnover_zone",
      comune: r.comune, provincia: r.provincia, area_label: r.area_label, microzona: r.microzona,
      score: r.score, temperature: r.temperature,
      reason_aggregated: r.reason ?? null,
      positive_factors: r.positive_factors ?? [],
      confidence: r.confidence_score, quality: r.quality,
      neutral_angle: "Aggiornare il report valori della zona per supportare i proprietari nella valutazione.",
    }));
    const aggArea = new Set(["comune","quartiere","microzona","sezione_censuaria","cap","zona_omi"]);
    const ipsAgg = (ips ?? []).filter((r: any) => aggArea.has(String(r.area_type ?? "").toLowerCase())).slice(0, topN).map((r: any) => ({
      kind: "inheritance_pressure_aggregate",
      comune: r.comune, provincia: r.provincia, area_label: r.area_label, area_type: r.area_type,
      score: r.score, indicators: r.indicators ?? {},
      confidence: r.confidence_score, quality: r.quality,
      neutral_angle: "Demografia di zona suggerisce turnover patrimoniale potenziale: utile per pianificare campagne valutative neutre.",
    }));

    turnover_aggregated_insights = [...etzAgg, ...ipsAgg];
    if (turnover_aggregated_insights.length > 0) {
      turnover_used = true;
      data_basis.push("estate_turnover_zones:aggregated", "inheritance_pressure_signals:aggregated");
    } else {
      missing_data.push("turnover_aggregated_insights");
    }
  }

  const recommended_actions: string[] = [];
  if (top_comuni.length > 0) recommended_actions.push(`Concentrare campagna su ${top_comuni.slice(0, 3).map((c) => c.comune).join(", ")}.`);
  if (top_microzones.length > 0) recommended_actions.push(`Aprire valutazioni in ${top_microzones.slice(0, 3).map((m) => m.area_label).join(", ")}.`);
  if (valuation_campaigns.length > 0) recommended_actions.push("Lanciare ciclo di report valori per microzone selezionate.");
  if (owner_education_angles.length > 0) recommended_actions.push("Inviare materiale educativo proprietari basato su dati OMI/zona.");
  if (turnover_used) recommended_actions.push("Usare turnover aggregato di zona per timing di campagne neutre (nessun outreach nominativo).");

  // Scripts: solo neutri, filtra forbidden topics (lutto/successione/ecc.)
  // Scripts: solo neutri, filtra forbidden topics (lutto/successione/ecc.) — helper importato in cima.
  const scripts = acquisition_opportunities
    .map((o) => {
      const raw = typeof o.owner_script === "string" ? o.owner_script : null;
      const safe = raw && isScriptSafeForSensitiveTurnover(raw).safe ? raw : buildNeutralZoneScript(o.comune, o.area_label);
      return { comune: o.comune, area_label: o.area_label, script: safe };
    })
    .slice(0, 5);

  const totalConf = (oos ?? []).reduce((s: number, r: any) => s + Number(r.confidence_score ?? 0), 0);
  const confidence = (oos?.length ?? 0) > 0 ? Math.round((totalConf / (oos!.length)) * 100) / 100 : 0;

  return {
    ok: true,
    dryRun,
    imported: false,
    needs_operating_area: false,
    scope: {
      area: ctx.area,
      preferences: ctx.preferences,
      excluded_categories: [
        ...(ctx.preferences.exclude_auctions ? ["auctions"] : []),
        ...(!ctx.preferences.include_public_alienations ? ["public_alienations"] : []),
        ...(!ctx.preferences.include_sensitive_turnover ? ["sensitive_turnover_nominative"] : []),
        "sensitive_nominative",
      ],
      sensitive_turnover_mode: ctx.preferences.include_sensitive_turnover_aggregated ? "aggregated_only" : "off",
    },
    counts: {
      offmarket_rows: oos?.length ?? 0,
      microzone_sentiment_rows: ms?.length ?? 0,
      area_opportunity_rows: aos?.length ?? 0,
      territorial_signals_filtered: tsFiltered.length,
      radar_signals_filtered: rsFiltered.length,
      turnover_aggregated_rows: turnover_aggregated_insights.length,
    },
    top_comuni,
    top_microzones,
    acquisition_opportunities,
    valuation_campaigns,
    owner_education_angles,
    turnover_aggregated_insights,
    recommended_actions,
    scripts,
    data_basis,
    missing_data,
    warnings,
    confidence,
    privacy: {
      personal_data_used: false,
      nominative_outreach_allowed: false,
      sensitive_topics_blocked_in_scripts: ["lutto","decesso","successione","eredi"],
    },
  };
}
