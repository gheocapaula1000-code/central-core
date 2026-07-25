// civiko-signals-classify
// STEP 3 — Motore di classificazione unificato dei segnali Civiko.
//
// - verify_jwt=false (invocato da pg_cron o admin operator)
// - Protetto da x-job-secret (constant-time vs CENTRAL_CORE_JOB_SECRET, fallback AI_CORE_SECRET)
// - Legge fino a limit_per_source righe per sorgente, oltre il watermark
//   MAX(collected_at) presente in civiko_signals_classified per quella sorgente
// - Applica classifySignal() dalla lib shared
// - dry_run=true: nessuna scrittura
// - dry_run=false: UPSERT su civiko_signals_classified ON CONFLICT (signal_id)
//
// Sorgenti primarie (7):
//   1. radar_signals
//   2. territorial_signals
//   3. inheritance_pressure_signals
//   4. legal_life_event_signals
//   5. legal_property_signals
//   6. turnover_signals
//   7. early_offmarket_signal_candidates
//
// ESCLUSI (vedi commento in _shared/civikoSignalClassification.ts):
//   - listing_velocity_signals    (derivato: età annuncio)
//   - pricing_error_signals       (derivato: delta vs OMI)

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  classifySignal,
  getSignalPolicy,
  type SignalPolicyDefaults,
  type SignalSensitivity,
} from "../_shared/civikoSignalClassification.ts";
import { constantTimeEqual, corsHeaders, json, fail, ok, makeDebugId } from "../_shared/http.ts";

// ─────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────
function requireJobSecret(req: Request, debugId: string): Response | null {
  const incoming = req.headers.get("x-job-secret") ?? "";
  const expected =
    Deno.env.get("CENTRAL_CORE_JOB_SECRET") ??
    Deno.env.get("AI_CORE_SECRET") ??
    "";
  if (!expected) {
    console.error("[civiko-signals-classify] no CENTRAL_CORE_JOB_SECRET/AI_CORE_SECRET configured");
    return fail(req, 500, "CONFIG_ERROR", "job secret not configured", debugId);
  }
  if (!incoming) return fail(req, 401, "JOB_SECRET_REQUIRED", "Missing x-job-secret", debugId);
  if (!constantTimeEqual(incoming, expected)) {
    return fail(req, 401, "JOB_SECRET_REJECTED", "Invalid x-job-secret", debugId);
  }
  return null;
}

// ─────────────────────────────────────────────
// Source config
// ─────────────────────────────────────────────
type SourceKey =
  | "radar_signals"
  | "territorial_signals"
  | "inheritance_pressure_signals"
  | "legal_life_event_signals"
  | "legal_property_signals"
  | "turnover_signals"
  | "early_offmarket_signal_candidates";

const ALL_SOURCES: SourceKey[] = [
  "radar_signals",
  "territorial_signals",
  "inheritance_pressure_signals",
  "legal_life_event_signals",
  "legal_property_signals",
  "turnover_signals",
  "early_offmarket_signal_candidates",
];

interface SourceConfig {
  table: SourceKey;
  // colonna timestamp usata come collected_at (ordinamento e watermark)
  tsSelect: string; // es. "COALESCE(updated_at, computed_at)"
  tsAlias: "collected_at";
  activeFilter: string | null; // es. "is_active = true"
  // Ritorna signal_type mappato sul POLICY_DEFAULTS della lib
  signalTypeFor: (row: Record<string, unknown>) => string;
  // Ritorna una frase commerciale neutra (mai PII), o null
  phraseFor: (row: Record<string, unknown>) => string | null;
  // Colonne da selezionare (in aggiunta a id e ts alias)
  extraColumns: string[];
}

// Helper: sanitizza rimuovendo termini invasivi anche in input phrase
function neutralize(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  // Cap 240 chars, no accapi, no doppi spazi
  return s.replace(/\s+/g, " ").slice(0, 240);
}

const SOURCES: Record<SourceKey, SourceConfig> = {
  radar_signals: {
    table: "radar_signals",
    tsSelect: "detected_at",
    tsAlias: "collected_at",
    activeFilter: "is_active.eq.true",
    signalTypeFor: (r) => String(r.signal_type ?? "local_buzz"),
    phraseFor: (r) => neutralize((r.title as string) ?? null),
    extraColumns: ["signal_type", "title", "municipality", "province", "lat", "lng", "confidence"],
  },
  territorial_signals: {
    table: "territorial_signals",
    tsSelect: "COALESCE(fetched_at, detected_at)",
    tsAlias: "collected_at",
    activeFilter: "is_active.eq.true",
    signalTypeFor: (r) => String(r.signal_type ?? "local_buzz"),
    phraseFor: (r) => neutralize((r.title as string) ?? null),
    extraColumns: ["signal_type", "title", "municipality", "province", "lat", "lng", "quality"],
  },
  inheritance_pressure_signals: {
    table: "inheritance_pressure_signals",
    tsSelect: "COALESCE(updated_at, computed_at)",
    tsAlias: "collected_at",
    activeFilter: "is_active.eq.true",
    signalTypeFor: () => "inheritance_pressure",
    phraseFor: (r) => {
      const area = neutralize((r.area_label as string) ?? (r.comune as string) ?? null);
      return area ? `Area con dinamica di ricambio proprietà elevata: ${area}` : null;
    },
    extraColumns: ["area_label", "comune", "provincia", "lat", "lng", "score", "quality"],
  },
  legal_life_event_signals: {
    table: "legal_life_event_signals",
    tsSelect: "COALESCE(updated_at, detected_at, created_at)",
    tsAlias: "collected_at",
    activeFilter: "is_active.eq.true",
    signalTypeFor: () => "legal_distress",
    // NB: frase neutra generica; la sensitivity è "alto" -> mai visibile all'agenzia.
    // La frase serve solo per rendere il segnale usable_for_scoring lato Core.
    phraseFor: (r) => {
      const area = neutralize((r.area_or_microzone as string) ?? (r.municipality as string) ?? null);
      return area ? `Segnale interno di contesto legale — ${area}` : "Segnale interno di contesto legale";
    },
    extraColumns: ["signal_type", "municipality", "province", "area_or_microzone", "confidence"],
  },
  legal_property_signals: {
    table: "legal_property_signals",
    tsSelect: "COALESCE(updated_at, fetched_at)",
    tsAlias: "collected_at",
    activeFilter: "is_active.eq.true",
    signalTypeFor: () => "legal_distress",
    phraseFor: (r) => {
      const area = neutralize((r.area_label as string) ?? (r.comune as string) ?? null);
      return area ? `Segnale interno di contesto legale — ${area}` : "Segnale interno di contesto legale";
    },
    extraColumns: ["signal_type", "comune", "provincia", "area_label", "lat", "lng", "quality"],
  },
  turnover_signals: {
    table: "turnover_signals",
    tsSelect: "COALESCE(updated_at, computed_at)",
    tsAlias: "collected_at",
    activeFilter: "is_active.eq.true",
    signalTypeFor: () => "estate_turnover",
    phraseFor: (r) => {
      const area = neutralize((r.area_label as string) ?? (r.comune as string) ?? null);
      const score = typeof r.turnover_potential_score === "number"
        ? ` (indice ${(r.turnover_potential_score as number).toFixed(2)})`
        : "";
      return area ? `Zona con potenziale di ricambio elevato${score}: ${area}` : null;
    },
    extraColumns: ["area_label", "comune", "provincia", "turnover_potential_score", "quality"],
  },
  early_offmarket_signal_candidates: {
    table: "early_offmarket_signal_candidates",
    tsSelect: "created_at",
    tsAlias: "collected_at",
    activeFilter: "status.eq.promoted",
    signalTypeFor: () => "motivated_seller",
    phraseFor: (r) => neutralize((r.title as string) ?? (r.summary as string) ?? null),
    extraColumns: ["signal_type", "title", "summary", "comune", "provincia", "quartiere", "quality", "status"],
  },
};

// ─────────────────────────────────────────────
// Carica policy override dal DB (una sola volta per run)
// ─────────────────────────────────────────────
async function loadPolicyOverrides(
  supa: ReturnType<typeof createClient>,
): Promise<Record<string, Partial<SignalPolicyDefaults>>> {
  const overrides: Record<string, Partial<SignalPolicyDefaults>> = {};
  const { data, error } = await supa.from("civiko_signal_policy").select("*");
  if (error) {
    console.warn("[classify] civiko_signal_policy load failed:", error.message);
    return overrides;
  }
  for (const row of data ?? []) {
    const st = String((row as Record<string, unknown>).signal_type ?? "");
    if (!st) continue;
    const r = row as Record<string, unknown>;
    const patch: Partial<SignalPolicyDefaults> = {};
    if (r.sensitivity_level != null) patch.sensitivity_level = r.sensitivity_level as SignalSensitivity;
    if (r.usable_for_scoring != null) patch.usable_for_scoring = Boolean(r.usable_for_scoring);
    if (r.visible_to_agency != null) patch.visible_to_agency = Boolean(r.visible_to_agency);
    if (r.visible_to_owner != null) patch.visible_to_owner = Boolean(r.visible_to_owner);
    if (r.retention_policy != null) patch.retention_policy = r.retention_policy as SignalPolicyDefaults["retention_policy"];
    if (Array.isArray(r.forbidden_phrases)) patch.forbidden_phrases = r.forbidden_phrases as string[];
    overrides[st] = patch;
  }
  console.log(`[classify] loaded ${Object.keys(overrides).length} policy overrides`);
  return overrides;
}

// ─────────────────────────────────────────────
// Watermark: MAX(collected_at) in civiko_signals_classified per sorgente
// ─────────────────────────────────────────────
async function getWatermark(
  supa: ReturnType<typeof createClient>,
  source: SourceKey,
): Promise<string | null> {
  const { data, error } = await supa
    .from("civiko_signals_classified")
    .select("collected_at")
    .eq("source_name_internal", source)
    .order("collected_at", { ascending: false })
    .limit(1);
  if (error) {
    console.warn(`[classify] watermark load failed for ${source}:`, error.message);
    return null;
  }
  return (data?.[0] as { collected_at?: string } | undefined)?.collected_at ?? null;
}

// ─────────────────────────────────────────────
// Fetch batch da sorgente
// ─────────────────────────────────────────────
async function fetchSourceBatch(
  supa: ReturnType<typeof createClient>,
  cfg: SourceConfig,
  watermark: string | null,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  // Uso RPC-style via .rpc solo se avessi una function DB; qui uso raw select con
  // COALESCE tramite un piccolo trick: seleziono i timestamp candidati e li faccio
  // collassare lato client. In alternativa, se tsSelect è una singola colonna, uso .order().
  const isSingleCol = /^[a-z_]+$/.test(cfg.tsSelect);
  const columns = ["id", ...new Set(cfg.extraColumns)];

  if (isSingleCol) {
    columns.push(cfg.tsSelect);
    let q = supa.from(cfg.table).select(columns.join(","));
    if (cfg.activeFilter) {
      const [col, op, val] = cfg.activeFilter.split(".");
      // deno-lint-ignore no-explicit-any
      q = (q as any).filter(col, op, val);
    }
    if (watermark) {
      // deno-lint-ignore no-explicit-any
      q = (q as any).gt(cfg.tsSelect, watermark);
    }
    // deno-lint-ignore no-explicit-any
    q = (q as any).order(cfg.tsSelect, { ascending: true }).limit(limit);
    const { data, error } = await q;
    if (error) throw new Error(`fetch ${cfg.table}: ${error.message}`);
    return (data ?? []).map((r) => ({
      ...(r as Record<string, unknown>),
      collected_at: (r as Record<string, unknown>)[cfg.tsSelect],
    }));
  }

  // COALESCE case: prendo tutte le colonne coinvolte, ordino client-side
  const coalesceCols = cfg.tsSelect
    .replace(/COALESCE\(|\)/gi, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of coalesceCols) if (!columns.includes(c)) columns.push(c);

  let q = supa.from(cfg.table).select(columns.join(","));
  if (cfg.activeFilter) {
    const [col, op, val] = cfg.activeFilter.split(".");
    // deno-lint-ignore no-explicit-any
    q = (q as any).filter(col, op, val);
  }
  // Nessun filtro server-side su COALESCE: dobbiamo fetchare un buffer e filtrare
  // client-side. Sovradimensioniamo di 3x, poi applichiamo il watermark.
  // deno-lint-ignore no-explicit-any
  q = (q as any).order(coalesceCols[0], { ascending: true }).limit(limit * 3);
  const { data, error } = await q;
  if (error) throw new Error(`fetch ${cfg.table}: ${error.message}`);
  const rows = (data ?? []).map((r) => {
    const rec = r as Record<string, unknown>;
    let ts: string | null = null;
    for (const c of coalesceCols) {
      const v = rec[c];
      if (v) { ts = String(v); break; }
    }
    return { ...rec, collected_at: ts };
  });
  const filtered = rows.filter((r) => r.collected_at && (!watermark || (r.collected_at as string) > watermark));
  filtered.sort((a, b) => String(a.collected_at).localeCompare(String(b.collected_at)));
  return filtered.slice(0, limit);
}

// ─────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────
Deno.serve(async (req) => {
  const debugId = makeDebugId();
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return fail(req, 405, "METHOD_NOT_ALLOWED", "POST required", debugId);
  }

  const authErr = requireJobSecret(req, debugId);
  if (authErr) return authErr;

  const t0 = Date.now();
  let body: {
    dry_run?: boolean;
    sources?: string[];
    limit_per_source?: number;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // body vuoto = default
  }
  const dry_run = Boolean(body.dry_run ?? false);
  const limit_per_source = Math.max(1, Math.min(2000, Number(body.limit_per_source ?? 500)));
  const requestedSources = Array.isArray(body.sources) && body.sources.length > 0
    ? body.sources.filter((s): s is SourceKey => (ALL_SOURCES as string[]).includes(s))
    : ALL_SOURCES;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supa = createClient(supabaseUrl, serviceKey);

  const policyOverrides = await loadPolicyOverrides(supa);

  const processed_by_source: Record<string, number> = {};
  const sensitivity_breakdown: Record<string, number> = { basso: 0, medio: 0, alto: 0, escluso: 0 };
  const usable_breakdown: Record<string, number> = { true: 0, false: 0 };
  const sample_records: Array<Record<string, unknown>> = [];
  let written = 0;
  const warnings: string[] = [];

  for (const src of requestedSources) {
    const cfg = SOURCES[src];
    try {
      const watermark = await getWatermark(supa, src);
      const rows = await fetchSourceBatch(supa, cfg, watermark, limit_per_source);
      processed_by_source[src] = rows.length;
      if (rows.length === 0) continue;

      const records = rows.map((row) => {
        const signal_type = cfg.signalTypeFor(row);
        const phrase = cfg.phraseFor(row);
        const collected_at = (row.collected_at as string) ?? new Date().toISOString();
        // Merge policy DB override sopra il default della lib
        const override = policyOverrides[signal_type];
        const rec = classifySignal({
          signal_id: `${src}:${row.id}`,
          signal_type,
          source_name_internal: src,
          collected_at,
          confidence_level: "media",
          allowed_commercial_phrase: phrase,
          override,
        });
        sensitivity_breakdown[rec.sensitivity_level] = (sensitivity_breakdown[rec.sensitivity_level] ?? 0) + 1;
        usable_breakdown[String(rec.usable_for_scoring)] += 1;
        if (sample_records.length < 3) {
          sample_records.push({
            signal_id: rec.signal_id,
            signal_type: rec.signal_type,
            sensitivity_level: rec.sensitivity_level,
            usable_for_scoring: rec.usable_for_scoring,
            allowed_commercial_phrase: rec.allowed_commercial_phrase,
            reason_code: rec.reason_code,
            source_name_internal: rec.source_name_internal,
          });
        }
        return rec;
      });

      if (!dry_run && records.length > 0) {
        // UPSERT in chunk da 200
        const chunk = 200;
        for (let i = 0; i < records.length; i += chunk) {
          const batch = records.slice(i, i + chunk).map((r) => ({
            signal_id: r.signal_id,
            signal_type: r.signal_type,
            source_name_internal: r.source_name_internal,
            collected_at: r.collected_at,
            confidence_level: r.confidence_level,
            sensitivity_level: r.sensitivity_level,
            usable_for_scoring: r.usable_for_scoring,
            visible_to_agency: r.visible_to_agency,
            visible_to_owner: r.visible_to_owner,
            allowed_commercial_phrase: r.allowed_commercial_phrase,
            forbidden_phrases: r.forbidden_phrases,
            retention_policy: r.retention_policy,
            payload: { reason_code: r.reason_code },
            updated_at: new Date().toISOString(),
          }));
          const { error: upErr } = await supa
            .from("civiko_signals_classified")
            .upsert(batch, { onConflict: "signal_id" });
          if (upErr) {
            warnings.push(`upsert ${src} chunk ${i}: ${upErr.message}`);
            console.error(`[classify] upsert error ${src}:`, upErr);
          } else {
            written += batch.length;
          }
        }
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      warnings.push(`${src}: ${msg}`);
      console.error(`[classify] source ${src} failed:`, msg);
      processed_by_source[src] = processed_by_source[src] ?? 0;
    }
  }

  const duration_ms = Date.now() - t0;
  const response = {
    ok: true,
    dry_run,
    duration_ms,
    processed_by_source,
    written,
    sensitivity_breakdown,
    usable_breakdown,
    sample_records,
    warnings,
    debug_id: debugId,
  };
  return json(req, 200, response, debugId);
});
