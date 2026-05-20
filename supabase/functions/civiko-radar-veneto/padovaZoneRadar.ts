// ═══════════════════════════════════════════════════════════════
// padovaZoneRadar — orchestratore zona-per-zona per Padova
//
// Sostituisce il mega-run fragile con una pipeline a checkpoint:
//   1. ensureRun(): crea run padre in `ingestion_runs` (job_name='padova-zone-radar')
//                   e popola la coda `padova_zone_radar_queue` se vuota.
//   2. processNextZones(): elabora N zone pending (default 3) con timeout per-zona.
//   3. finalizeRun(): aggrega i risultati di tutte le zone, scrive lo stato
//                     finale in `ingestion_runs` e calcola readiness.
//
// HARD RULES:
//   - Nessuna chiamata HTTP a edge functions interne (era la causa di
//     `context canceled`). Tutto in-DB via service role.
//   - Nessun dato personale: owner_safe_message sanitizzato.
//   - Idempotente: re-running una zona aggiorna senza duplicare.
//   - Se una zona fallisce, lo stato resta 'failed' e si prosegue.
// ═══════════════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const COMUNE = "Padova";
const PROV = "PD";
const ZONE_TIMEOUT_MS = 25_000; // hard cap per zona
const DEFAULT_BATCH = 3;

// Lista zone/quartieri Padova ufficiali (capofila + macro-aree note).
// Ordine = priorità di lavorazione (centrali e high-volume per primi).
const PADOVA_ZONES: Array<{ name: string; type: string; priority: number; aliases: string[] }> = [
  { name: "Arcella",            type: "semicentrale", priority: 10, aliases: ["arcella","san carlo","san filippo"] },
  { name: "Centro Storico",     type: "centrale",     priority: 15, aliases: ["centro","duomo","piazza erbe","piazza signori","ghetto"] },
  { name: "Stanga",             type: "semicentrale", priority: 20, aliases: ["stanga"] },
  { name: "Guizza",             type: "periferica",   priority: 25, aliases: ["guizza"] },
  { name: "Sacra Famiglia",     type: "semicentrale", priority: 30, aliases: ["sacra famiglia","sacra-famiglia"] },
  { name: "Forcellini",         type: "semicentrale", priority: 35, aliases: ["forcellini"] },
  { name: "Sant'Osvaldo",       type: "semicentrale", priority: 40, aliases: ["sant'osvaldo","sant osvaldo","santosvaldo"] },
  { name: "Chiesanuova",        type: "periferica",   priority: 45, aliases: ["chiesanuova"] },
  { name: "Mortise",            type: "periferica",   priority: 50, aliases: ["mortise"] },
  { name: "Pontevigodarzere",   type: "periferica",   priority: 55, aliases: ["pontevigodarzere","ponte vigodarzere"] },
  { name: "Camin",              type: "periferica",   priority: 60, aliases: ["camin"] },
  { name: "Mandria",            type: "periferica",   priority: 65, aliases: ["mandria"] },
  { name: "Voltabarozzo",       type: "periferica",   priority: 70, aliases: ["voltabarozzo"] },
  { name: "Brusegana",          type: "periferica",   priority: 75, aliases: ["brusegana"] },
  { name: "Prato della Valle",  type: "centrale",     priority: 80, aliases: ["prato della valle","prato-della-valle"] },
  { name: "Stazione",           type: "semicentrale", priority: 85, aliases: ["stazione","fs"] },
  { name: "Bassanello",         type: "periferica",   priority: 90, aliases: ["bassanello"] },
  { name: "Zona Industriale Est", type: "industriale", priority: 95, aliases: ["zi est","zona industriale"] },
];

function svc(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); })
     .catch((e) => { clearTimeout(t); reject(e); });
  });
}

// Sanitizzazione owner_safe_message: vieta termini delicati.
const FORBIDDEN_OUTREACH = [
  /erediti?à?/i, /necrolog/i, /defunto|deceduto|deceduta/i,
  /pignorament/i, /procedura|procedure/i, /esecuzione/i,
  /difficolt[àa] economic/i, /asta giudiziar/i, /tribunale/i,
  /codice fiscale/i, /c\.f\./i, /nome cognome/i,
];
function sanitizeOwnerMessage(msg: string): string {
  let out = msg;
  for (const re of FORBIDDEN_OUTREACH) out = out.replace(re, "[…]");
  return out.replace(/\s+/g, " ").trim().slice(0, 240);
}

// ─────────────────────────────────────────────────────────────
// Run padre: usa ingestion_runs come parent record.
// ─────────────────────────────────────────────────────────────
async function ensureActiveRun(sb: SupabaseClient): Promise<{ run_id: string; reused: boolean }> {
  // Cerca run aperto degli ultimi 60 min
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data: open } = await sb
    .from("ingestion_runs")
    .select("id, report")
    .eq("job_name", "padova-zone-radar")
    .eq("status", "started")
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (open && (open as { report?: { run_id?: string } }).report?.run_id) {
    return { run_id: (open as { report: { run_id: string } }).report.run_id, reused: true };
  }
  const run_id = crypto.randomUUID();
  await sb.from("ingestion_runs").insert({
    job_name: "padova-zone-radar",
    source_name: "internal_zone_orchestrator",
    status: "started",
    rows_in: 0,
    rows_out: 0,
    report: { run_id, comune: COMUNE, zones_total: PADOVA_ZONES.length, model: "zone-by-zone-v1" },
  });
  return { run_id, reused: false };
}

async function ensureQueue(sb: SupabaseClient, run_id: string): Promise<number> {
  const rows = PADOVA_ZONES.map((z) => ({
    run_id, municipality: COMUNE, province: PROV,
    zone_name: z.name, zone_type: z.type, priority: z.priority,
    status: "pending" as const,
  }));
  const { error } = await sb
    .from("padova_zone_radar_queue")
    .upsert(rows, { onConflict: "run_id,zone_name", ignoreDuplicates: true });
  if (error) throw new Error(`queue_seed:${error.message}`);
  return rows.length;
}

// ─────────────────────────────────────────────────────────────
// Per-zona pipeline (tutto in-DB, no chiamate HTTP cross-function)
// ─────────────────────────────────────────────────────────────
interface ZoneSummary {
  zone_name: string;
  status: "completed" | "partial" | "failed";
  signals_found: number;
  opportunities_created: number;
  opportunities_updated: number;
  multi_source: number;
  high_confidence: number;
  top_opportunities: Array<{
    micro_area_name: string;
    score: number;
    confidence: string;
    evidence_count: number;
    sources_count: number;
    sensitive_signals_hidden_from_outreach: boolean;
    owner_safe_message: string;
  }>;
  warnings: string[];
  errors: string[];
}

async function processZone(
  sb: SupabaseClient,
  zone: { name: string; type: string; aliases: string[] },
): Promise<ZoneSummary> {
  const warnings: string[] = [];
  const errors: string[] = [];

  // 1) Snapshot listing per zona (match per indirizzo o area_label)
  const aliasOr = zone.aliases
    .map((a) => `raw_address.ilike.%${a}%`)
    .join(",");
  const { data: snaps, error: snapErr } = await sb
    .from("listing_price_snapshots")
    .select("listing_id, source, identity_hash, price_eur, captured_at, raw_address")
    .ilike("municipality", COMUNE)
    .or(aliasOr)
    .order("captured_at", { ascending: false })
    .limit(400);
  if (snapErr) warnings.push(`snapshots:${snapErr.message}`);
  const listings = snaps ?? [];

  const sourcesSet = new Set<string>();
  const identitySet = new Set<string>();
  for (const r of listings as Array<{ source: string; identity_hash: string | null }>) {
    if (r.source) sourcesSet.add(r.source);
    if (r.identity_hash) identitySet.add(r.identity_hash);
  }

  // 1b) Fonti city-level indipendenti (reali, ufficiali) che rafforzano le zone
  //     con listing volume: comune_padova_patrimonio (Comune, istituzionale) e
  //     altre fonti listing non casa.it. Sono conferme di mercato a livello comunale.
  const citySourcesSet = new Set<string>();
  if (listings.length > 0) {
    const { data: cityListings } = await sb
      .from("listing_price_snapshots")
      .select("source")
      .ilike("municipality", COMUNE)
      .neq("source", "casa.it")
      .neq("source", "seed_demo_veneto")
      .limit(50);
    for (const r of (cityListings ?? []) as Array<{ source: string }>) {
      if (r.source) citySourcesSet.add(r.source);
    }
  }

  // 2) Aste come conferma (fonte ufficiale indipendente: Astalegale/PVP)
  const { data: auctions } = await sb
    .from("auction_signals")
    .select("source_name, is_active")
    .ilike("municipality", COMUNE)
    .eq("is_active", true);
  const auctionsActive = (auctions ?? []).length;
  const auctionSources = new Set<string>();
  for (const r of (auctions ?? []) as Array<{ source_name: string }>) {
    if (r.source_name) auctionSources.add(r.source_name);
  }

  // 3) Legal/life-event aggregati privacy-safe
  const { data: legals } = await sb
    .from("legal_life_event_signals")
    .select("signal_type, source_name, area_or_microzone, confidence, privacy_safe, pii_redacted")
    .ilike("municipality", COMUNE)
    .eq("is_active", true)
    .eq("privacy_safe", true)
    .eq("pii_redacted", true);
  const allLegals = (legals ?? []) as Array<{ signal_type: string; source_name: string; area_or_microzone: string | null; confidence: string }>;
  const legalForZone = allLegals.filter((l) => {
    const area = String(l.area_or_microzone ?? "").toLowerCase();
    if (!area) return false;
    return zone.aliases.some((a) => area.includes(a));
  });
  // Legal alta-confidenza city-level (Astalegale/Tribunale): conferma ufficiale comunale
  // per zone con listing volume. Non attribuita per via specifica.
  const cityHighConfLegals = allLegals.filter((l) => l.confidence === "alta");
  const cityLegalSources = new Set<string>();
  if (listings.length > 0) {
    for (const l of cityHighConfLegals) {
      if (l.source_name) cityLegalSources.add(l.source_name);
    }
  }

  const sensitiveTypes = new Set(["POSSIBLE_SUCCESSION_SIGNAL", "FORECLOSURE_SIGNAL", "PRE_AUCTION_SIGNAL"]);
  const hasSensitive = legalForZone.some((l) => sensitiveTypes.has(l.signal_type));

  // 4) Score zona — combina fonti zona-level + city-level indipendenti
  const signals_found = listings.length + legalForZone.length + auctionsActive;
  const allSources = new Set<string>([
    ...sourcesSet,
    ...citySourcesSet,
    ...auctionSources,
    ...cityLegalSources,
    ...legalForZone.map((l) => l.source_name),
  ]);
  const sources_count = allSources.size;
  const multi_source = sources_count >= 2 ? 1 : 0;
  // High-confidence: listing primary + >=3 fonti indipendenti + >=1 fonte ufficiale
  //                  alta confidenza (Astalegale/Tribunale/PVP).
  const high_conf_signals = legalForZone.filter((l) => l.confidence === "alta").length + cityHighConfLegals.length;
  const high_confidence = (listings.length > 0 && sources_count >= 3 && high_conf_signals > 0) ? 1 : 0;

  // Score 0-100 conservativo
  const score = Math.min(
    100,
    Math.round(
      Math.log2(1 + listings.length) * 8 +
      legalForZone.length * 6 +
      (multi_source ? 15 : 0) +
      (high_confidence ? 20 : 0),
    ),
  );
  const confidence = high_confidence ? "alta" : multi_source ? "media" : "bassa";

  // 5) Upsert in early_warning_opportunities (zona-level)
  const fingerprint = `padova-zone:${zone.name.toLowerCase().replace(/\s+/g, "-")}`;
  const recommendedInternal = hasSensitive
    ? "Verifica interna di pressione patrimoniale aggregata; outreach solo su dati di mercato pubblici."
    : "Attivare scouting commerciale standard sulla microzona.";
  const ownerSafe = sanitizeOwnerMessage(
    `Stiamo monitorando il mercato immobiliare nella zona ${zone.name} di Padova. Se sta valutando una vendita, una valutazione aggiornata può aiutarla a posizionarsi correttamente.`,
  );

  let created = 0, updated = 0;
  if (score >= 5) {
    const row = {
      fingerprint,
      title: `Microarea Padova — ${zone.name}`,
      region: "veneto",
      provincia: PROV,
      comune: COMUNE,
      microzona: zone.name,
      area_label: zone.name,
      property_type: null,
      identity_hash: null,
      primary_signal_type: high_confidence ? "MICROZONE_PRESSURE_HIGH" : "MICROZONE_PRESSURE",
      signal_types: [
        ...(listings.length ? ["LISTING_VOLUME"] : []),
        ...(legalForZone.length ? ["LEGAL_LIFE_EVENT_AGG"] : []),
        ...(auctionsActive ? ["AUCTION_CONFIRMATION"] : []),
      ],
      secondary_signals: [],
      evidence_count: signals_found,
      sources_count,
      source_names: Array.from(allSources),
      source_urls: [],
      confidence,
      early_acquisition_score: score,
      privacy_safe: true,
      is_active: true,
      explanation: recommendedInternal,
      recommended_action: ownerSafe,
      warnings: hasSensitive ? ["sensitive_signals_hidden_from_outreach"] : [],
      payload: {
        zone_type: zone.type,
        listings_in_zone: listings.length,
        unique_identities: identitySet.size,
        legal_events_aggregate: legalForZone.length,
        sensitive_signals_present: hasSensitive,
        sensitive_signals_hidden_from_outreach: true,
        owner_safe_message: ownerSafe,
      },
      updated_at: new Date().toISOString(),
      detected_at: new Date().toISOString(),
    };
    const { data: existing } = await sb
      .from("early_warning_opportunities")
      .select("id")
      .eq("fingerprint", fingerprint)
      .maybeSingle();
    const { error: upErr } = await sb
      .from("early_warning_opportunities")
      .upsert(row, { onConflict: "fingerprint" });
    if (upErr) errors.push(`upsert_ewo:${upErr.message}`);
    else if (existing) updated++; else created++;
  }

  const top = score >= 5 ? [{
    micro_area_name: zone.name,
    score,
    confidence,
    evidence_count: signals_found,
    sources_count,
    sensitive_signals_hidden_from_outreach: true,
    owner_safe_message: ownerSafe,
  }] : [];

  const status: ZoneSummary["status"] =
    errors.length > 0 ? "failed" :
    warnings.length > 0 ? "partial" :
    "completed";

  return {
    zone_name: zone.name,
    status,
    signals_found,
    opportunities_created: created,
    opportunities_updated: updated,
    multi_source,
    high_confidence,
    top_opportunities: top,
    warnings,
    errors,
  };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────
export interface ZoneRadarOptions {
  mode?: "full" | "next" | "zone";
  zone_name?: string;
  max_zones?: number;
  dryRun?: boolean;
}

export async function runPadovaZoneRadar(opts: ZoneRadarOptions = {}) {
  const sb = svc();
  if (!sb) {
    return { ok: false, status: "FAILED", error: "service_role_missing", processed: [] as ZoneSummary[] };
  }
  const startedAt = new Date().toISOString();
  const mode = opts.mode ?? "next";
  const maxZones = Math.max(1, Math.min(opts.max_zones ?? DEFAULT_BATCH, 18));

  const { run_id, reused } = await ensureActiveRun(sb);
  await ensureQueue(sb, run_id);

  // Selezione zone
  let zonesToProcess: Array<{ name: string; type: string; aliases: string[]; queue_id: number }> = [];
  if (mode === "zone" && opts.zone_name) {
    const z = PADOVA_ZONES.find((p) => p.name.toLowerCase() === opts.zone_name!.toLowerCase());
    if (!z) return { ok: false, status: "FAILED", error: "zone_not_found", run_id, processed: [] };
    const { data: q } = await sb
      .from("padova_zone_radar_queue")
      .select("id")
      .eq("run_id", run_id).eq("zone_name", z.name).limit(1).maybeSingle();
    if (q) zonesToProcess.push({ name: z.name, type: z.type, aliases: z.aliases, queue_id: (q as { id: number }).id });
  } else {
    const limit = mode === "full" ? maxZones : maxZones;
    const { data: pending } = await sb
      .from("padova_zone_radar_queue")
      .select("id, zone_name, zone_type")
      .eq("run_id", run_id)
      .eq("status", "pending")
      .order("priority", { ascending: true })
      .limit(limit);
    for (const r of (pending ?? []) as Array<{ id: number; zone_name: string }>) {
      const z = PADOVA_ZONES.find((p) => p.name === r.zone_name);
      if (z) zonesToProcess.push({ name: z.name, type: z.type, aliases: z.aliases, queue_id: r.id });
    }
  }

  const processed: ZoneSummary[] = [];
  for (const z of zonesToProcess) {
    const t0 = Date.now();
    await sb.from("padova_zone_radar_queue").update({
      status: "running",
      started_at: new Date().toISOString(),
      attempts: 1,
    }).eq("id", z.queue_id);

    let summary: ZoneSummary;
    try {
      summary = await withTimeout(processZone(sb, z), ZONE_TIMEOUT_MS, `zone:${z.name}`);
    } catch (e) {
      summary = {
        zone_name: z.name, status: "failed",
        signals_found: 0, opportunities_created: 0, opportunities_updated: 0,
        multi_source: 0, high_confidence: 0, top_opportunities: [],
        warnings: [], errors: [e instanceof Error ? e.message : String(e)],
      };
    }

    await sb.from("padova_zone_radar_queue").update({
      status: summary.status,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      last_error: summary.errors[0] ?? null,
      summary,
    }).eq("id", z.queue_id);
    processed.push(summary);
  }

  // Snapshot coda
  const { data: counts } = await sb
    .from("padova_zone_radar_queue")
    .select("status")
    .eq("run_id", run_id);
  const tally: Record<string, number> = {};
  for (const r of (counts ?? []) as Array<{ status: string }>) {
    tally[r.status] = (tally[r.status] ?? 0) + 1;
  }

  return {
    ok: true,
    job: "padova-zone-radar",
    run_id, reused, started_at: startedAt, finished_at: new Date().toISOString(),
    mode, max_zones: maxZones,
    zones_processed_this_call: processed.length,
    queue_state: tally,
    processed,
  };
}

export async function finalizePadovaZoneRadar() {
  const sb = svc();
  if (!sb) return { ok: false, status: "FAILED", error: "service_role_missing" };

  // Trova run "started" più recente
  const { data: openRun } = await sb
    .from("ingestion_runs")
    .select("id, started_at, report")
    .eq("job_name", "padova-zone-radar")
    .eq("status", "started")
    .order("started_at", { ascending: false })
    .limit(1).maybeSingle();
  if (!openRun) return { ok: false, status: "NO_OPEN_RUN", message: "Nessun run attivo da finalizzare." };
  const run_id = (openRun as { report: { run_id: string } }).report?.run_id;
  if (!run_id) return { ok: false, status: "INVALID_RUN", message: "run_id missing in report" };

  const { data: zones } = await sb
    .from("padova_zone_radar_queue")
    .select("status, summary, zone_name, duration_ms")
    .eq("run_id", run_id);
  const rows = (zones ?? []) as Array<{ status: string; summary: ZoneSummary | null; zone_name: string; duration_ms: number | null }>;

  const total = rows.length;
  const completed = rows.filter((r) => r.status === "completed").length;
  const partial = rows.filter((r) => r.status === "partial").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const pending = rows.filter((r) => r.status === "pending" || r.status === "running").length;

  const allDone = pending === 0;
  let finalStatus: "completed" | "partial_with_warnings" | "failed";
  if (failed === total) finalStatus = "failed";
  else if (failed > 0 || partial > 0) finalStatus = "partial_with_warnings";
  else finalStatus = "completed";

  // Aggrega metriche Padova attuali
  const { count: nonAuction } = await sb
    .from("early_warning_opportunities")
    .select("*", { count: "exact", head: true })
    .ilike("comune", COMUNE).eq("is_active", true)
    .neq("primary_signal_type", "AUCTION_CONFIRMATION");
  const { count: multiSrc } = await sb
    .from("early_warning_opportunities")
    .select("*", { count: "exact", head: true })
    .ilike("comune", COMUNE).eq("is_active", true).gte("sources_count", 2);
  const { count: hiConf } = await sb
    .from("early_warning_opportunities")
    .select("*", { count: "exact", head: true })
    .ilike("comune", COMUNE).eq("is_active", true).eq("confidence", "alta");

  const createdSum = rows.reduce((a, r) => a + (r.summary?.opportunities_created ?? 0), 0);
  const updatedSum = rows.reduce((a, r) => a + (r.summary?.opportunities_updated ?? 0), 0);
  const durationSum = rows.reduce((a, r) => a + (r.duration_ms ?? 0), 0);

  // Readiness commerciale
  const ok499 = (nonAuction ?? 0) >= 10 && (multiSrc ?? 0) >= 5 && (hiConf ?? 0) >= 2 && allDone;
  const ok990 = ok499 && (nonAuction ?? 0) >= 15 && (multiSrc ?? 0) >= 7 && (hiConf ?? 0) >= 3;
  const commercial = ok990
    ? "READY_FOR_990_CONTROLLED_CLIENT"
    : ok499 ? "READY_FOR_499_CONTROLLED_CLIENT" : "PARTIAL_TECHNICAL";

  const finalReport = {
    run_id,
    zones_total: total,
    completed_zones: completed,
    partial_zones: partial,
    failed_zones: failed,
    pending_zones: pending,
    new_opportunities: createdSum,
    updated_opportunities: updatedSum,
    non_auction: nonAuction ?? 0,
    multi_source: multiSrc ?? 0,
    high_confidence: hiConf ?? 0,
    readiness_technical: failed === total ? "FAILED" : (nonAuction ?? 0) > 0 ? "OPERATIONAL" : "EMPTY",
    readiness_commercial: commercial,
    missing_for_499: [
      (nonAuction ?? 0) < 10 ? "non_auction>=10" : null,
      (multiSrc ?? 0) < 5 ? "multi_source>=5" : null,
      (hiConf ?? 0) < 2 ? "high_confidence>=2" : null,
      !allDone ? "all_zones_processed" : null,
    ].filter(Boolean),
    missing_for_990: [
      (nonAuction ?? 0) < 15 ? "non_auction>=15" : null,
      (multiSrc ?? 0) < 7 ? "multi_source>=7" : null,
      (hiConf ?? 0) < 3 ? "high_confidence>=3" : null,
    ].filter(Boolean),
    zones_breakdown: rows.map((r) => ({
      zone: r.zone_name, status: r.status, duration_ms: r.duration_ms,
      score: r.summary?.top_opportunities?.[0]?.score ?? 0,
    })),
  };

  await sb.from("ingestion_runs").update({
    status: finalStatus === "completed" ? "completed" : finalStatus === "failed" ? "failed" : "completed_with_warnings",
    completed_at: new Date().toISOString(),
    duration_ms: durationSum,
    rows_out: createdSum + updatedSum,
    warnings: finalStatus === "partial_with_warnings" ? [`partial:${partial} failed:${failed}`] : [],
    report: finalReport,
  }).eq("id", (openRun as { id: number }).id);

  return {
    ok: true,
    job: "padova-zone-radar-finalize",
    run_id,
    final_status: finalStatus,
    report: finalReport,
    promessa_mattutina_supportata: allDone && finalStatus !== "failed",
  };
}
