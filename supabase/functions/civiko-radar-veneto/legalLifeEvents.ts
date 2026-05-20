// ═══════════════════════════════════════════════════════════════
// Padova Legal & Life-Event Signals layer
//
// Aggrega in `legal_life_event_signals` segnali legali/patrimoniali
// e life-event GIÀ raccolti da fonti lecite, applicando:
//   • Minimizzazione (nessun nome, niente PII, payload ridotto)
//   • Privacy gate: privacy_safe=true e pii_redacted=true obbligatori
//   • source_url reale richiesto per ogni segnale
//   • Confidence cap: necrologi/successioni mai oltre "bassa"
//   • Dedupe per dedupe_key
//
// FONTI USATE (lecite, già ingestite altrove):
//   auction_signals               → AUCTION_CONFIRMATION
//   legal_property_signals        → FORECLOSURE_SIGNAL / PRE_AUCTION_SIGNAL / AUCTION_CONFIRMATION
//   inheritance_pressure_signals  → POSSIBLE_SUCCESSION_SIGNAL (aggregate only)
//   early_offmarket_signal_candidates (promoted)
//        signal_type ∈ {concession_or_lease_signal,
//                       public_asset_disposal,
//                       urban_planning_signal,
//                       municipal_property_signal,
//                       public_notice_signal}
//
// FONTI VALUTATE E SCARTATE PER PRIVACY/ToS (NON IMPLEMENTATE):
//   PVP (Portale Vendite Pubbliche)   → richiede registrazione + ToS restrittivi
//   astegiudiziarie.it (login)        → ToS no scraping
//   Tribunale di Padova HTML diretto  → ad-hoc, fragile, basso ROI
//   necrologi nominativi (siti privati e quotidiani)
//        → ALTO rischio privacy + GDPR; vietato salvare nomi
//        → useremmo solo aggregati anonimi (inheritance_pressure_signals)
//   conservatoria/visure              → richiede licenza Equitalia/Sogei
// ═══════════════════════════════════════════════════════════════
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const COMUNE = "Padova";
const PROV = "PD";

// Termini che, se presenti nel testo, fanno scartare il segnale
const PII_BLOCKLIST = [
  /\b(sig|sigra|sigr|signor|signora|signora|defunto|defunta|deceduto|deceduta|erede|eredi)\b/i,
  /\b(nato|nata) (a|il)\b/i,
  /\bcodice fiscale\b/i,
  /\bC\.F\.\b/i,
];

function hasPII(text: string | null | undefined): boolean {
  if (!text) return false;
  return PII_BLOCKLIST.some((re) => re.test(text));
}

function minimizeTitle(t: string | null | undefined, fallback: string): string {
  if (!t) return fallback;
  const cleaned = String(t).replace(/\s+/g, " ").trim();
  if (hasPII(cleaned)) return fallback;
  return cleaned.length > 180 ? cleaned.slice(0, 177) + "…" : cleaned;
}

function digest(s: string): string {
  // FNV-1a 64-bit-ish
  let h = 0xcbf29ce4n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}

function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try { const url = new URL(u); return url.toString(); } catch { return null; }
}

interface BuiltSignal {
  signal_type: string;
  source_name: string;
  source_url: string;          // required
  event_date: string | null;
  area_or_microzone: string | null;
  property_hint: string | null;
  confidence: "bassa" | "media" | "alta";
  privacy_safe: boolean;
  contains_personal_data: boolean;
  pii_redacted: boolean;
  legal_basis_note: string;
  explanation: string;
  dedupe_key: string;
  payload_minimized: Record<string, unknown>;
}

export interface LegalLifeEventOptions {
  dryRun?: boolean;
}

export interface LegalLifeEventResult {
  ok: boolean;
  dry_run: boolean;
  comune: string;
  sources_queried: string[];
  found: number;
  inserted: number;
  updated: number;
  discarded: number;
  needs_review: number;
  discarded_reasons: Record<string, number>;
  by_signal_type: Record<string, number>;
  samples: Array<Record<string, unknown>>;
  warnings: string[];
  started_at: string;
  ended_at: string;
}

export async function refreshPadovaLegalLifeEvents(
  opts: LegalLifeEventOptions = {},
): Promise<LegalLifeEventResult> {
  const startedAt = new Date().toISOString();
  const sb: SupabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const warnings: string[] = [];
  const discarded_reasons: Record<string, number> = {};
  const bump = (k: string) => { discarded_reasons[k] = (discarded_reasons[k] ?? 0) + 1; };
  const sources_queried: string[] = [];
  const candidates: BuiltSignal[] = [];

  // ── 1. auction_signals → AUCTION_CONFIRMATION ─────────────────
  sources_queried.push("auction_signals");
  {
    const { data, error } = await sb
      .from("auction_signals")
      .select("source_name, source_url, sale_date, payload, fingerprint, property_type, municipality, is_active")
      .ilike("municipality", COMUNE)
      .eq("is_active", true)
      .range(0, 999);
    if (error) warnings.push(`auction_signals_query:${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const url = safeUrl(r.source_url as string);
      if (!url) { bump("missing_source_url"); continue; }
      const title = minimizeTitle((r.payload as any)?.address ?? null, "Asta giudiziaria Padova");
      if (hasPII(JSON.stringify(r.payload ?? {}))) { bump("payload_pii"); continue; }
      candidates.push({
        signal_type: "AUCTION_CONFIRMATION",
        source_name: String(r.source_name ?? "auction"),
        source_url: url,
        event_date: (r.sale_date as string) ?? null,
        area_or_microzone: title,
        property_hint: (r.property_type as string) ?? null,
        confidence: "media",
        privacy_safe: true,
        contains_personal_data: false,
        pii_redacted: true,
        legal_basis_note: "Pubblicità legale: asta giudiziaria pubblicata dalla fonte ufficiale del portale autorizzato.",
        explanation: "Conferma asta pubblica (segnale di conferma, non primario).",
        dedupe_key: `auc:${r.fingerprint}`,
        payload_minimized: {
          property_type: r.property_type ?? null,
          sale_date: r.sale_date ?? null,
        },
      });
    }
  }

  // ── 2. legal_property_signals → mappato per tipo ──────────────
  sources_queried.push("legal_property_signals");
  {
    const { data, error } = await sb
      .from("legal_property_signals")
      .select("signal_type, source_name, source_url, sale_date, comune, property_type, payload, fingerprint, privacy_redacted, is_active")
      .ilike("comune", COMUNE)
      .eq("is_active", true)
      .range(0, 999);
    if (error) warnings.push(`legal_property_signals_query:${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const url = safeUrl(r.source_url as string);
      if (!url) { bump("missing_source_url"); continue; }
      if (hasPII(JSON.stringify(r.payload ?? {}))) { bump("payload_pii"); continue; }
      const raw = String(r.signal_type ?? "").toLowerCase();
      let mapped: BuiltSignal["signal_type"];
      if (/pignor|foreclo|esecuzione|procedura/.test(raw)) mapped = "FORECLOSURE_SIGNAL";
      else if (/pre.?asta|pre.?auction/.test(raw)) mapped = "PRE_AUCTION_SIGNAL";
      else if (/asta|auction/.test(raw)) mapped = "AUCTION_CONFIRMATION";
      else mapped = "PUBLIC_NOTICE_SIGNAL";
      const confidence: BuiltSignal["confidence"] = mapped === "FORECLOSURE_SIGNAL" || mapped === "PRE_AUCTION_SIGNAL" ? "media" : "bassa";
      candidates.push({
        signal_type: mapped,
        source_name: String(r.source_name ?? "legal_source"),
        source_url: url,
        event_date: (r.sale_date as string) ?? null,
        area_or_microzone: minimizeTitle((r.payload as any)?.area_label ?? null, "Procedura legale Padova"),
        property_hint: (r.property_type as string) ?? null,
        confidence,
        privacy_safe: r.privacy_redacted !== false,
        contains_personal_data: false,
        pii_redacted: true,
        legal_basis_note: "Pubblicità legale (procedura esecutiva/asta) pubblicata da fonte istituzionale o portale autorizzato.",
        explanation: "Segnale legale derivato da fonte pubblica ufficiale.",
        dedupe_key: `lps:${r.fingerprint ?? digest(url)}`,
        payload_minimized: {
          original_type: raw,
          property_type: r.property_type ?? null,
          sale_date: r.sale_date ?? null,
        },
      });
    }
  }

  // ── 3. inheritance_pressure_signals → POSSIBLE_SUCCESSION_SIGNAL (aggregate) ─
  sources_queried.push("inheritance_pressure_signals");
  {
    const { data, error } = await sb
      .from("inheritance_pressure_signals")
      .select("area_label, source_urls, source_names, indicators, fingerprint, is_active")
      .ilike("comune", COMUNE)
      .eq("is_active", true)
      .range(0, 999);
    if (error) warnings.push(`inheritance_query:${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const url = safeUrl(((r.source_urls as string[]) ?? [])[0]);
      if (!url) { bump("missing_source_url"); continue; }
      const ind = r.indicators ?? {};
      // Aggregato puro: nessun riferimento a persone
      if (hasPII(JSON.stringify(ind))) { bump("indicators_pii"); continue; }
      candidates.push({
        signal_type: "POSSIBLE_SUCCESSION_SIGNAL",
        source_name: String(((r.source_names as string[]) ?? [])[0] ?? "inheritance_aggregate"),
        source_url: url,
        event_date: null,
        area_or_microzone: (r.area_label as string) ?? null,
        property_hint: null,
        confidence: "bassa", // CAP: mai oltre bassa senza incrocio lecito
        privacy_safe: true,
        contains_personal_data: false,
        pii_redacted: true,
        legal_basis_note: "Indicatori aggregati ISTAT/anagrafici a livello di area; nessun dato identificativo.",
        explanation: "Possibile pressione successoria a livello di microzona (segnale debole, da incrociare).",
        dedupe_key: `inh:${r.fingerprint ?? digest((r.area_label as string) ?? "padova")}`,
        payload_minimized: { indicators_keys: Object.keys((ind as object) ?? {}) },
      });
    }
  }

  // ── 4. early_offmarket_signal_candidates (promoted, non-irrelevant) ───
  sources_queried.push("early_offmarket_signal_candidates");
  {
    const { data, error } = await sb
      .from("early_offmarket_signal_candidates")
      .select("title, signal_type, source_name, source_url, comune, payload, privacy_safe, status, ai_summary")
      .ilike("comune", COMUNE)
      .eq("status", "promoted")
      .range(0, 999);
    if (error) warnings.push(`offmarket_query:${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const url = safeUrl(r.source_url as string);
      if (!url) { bump("missing_source_url"); continue; }
      if (r.privacy_safe === false) { bump("offmarket_not_privacy_safe"); continue; }
      const rawType = String(r.signal_type ?? "").toLowerCase();
      if (rawType === "irrelevant") { bump("irrelevant"); continue; }
      let mapped: BuiltSignal["signal_type"] | null = null;
      if (/concession|lease/.test(rawType)) mapped = "CONCESSION_OR_LEASE_SIGNAL";
      else if (/public_asset|alienaz|patrimonio/.test(rawType)) mapped = "PUBLIC_ASSET_DISPOSAL";
      else if (/municipal|comune/.test(rawType)) mapped = "MUNICIPAL_PROPERTY_SIGNAL";
      else if (/urban|piano|prg|puc|pat/.test(rawType)) mapped = "URBAN_PLANNING_SIGNAL";
      else if (/notice|bando|avviso|public/.test(rawType)) mapped = "PUBLIC_NOTICE_SIGNAL";
      if (!mapped) { bump("offmarket_unmapped_type"); continue; }
      const title = minimizeTitle(r.title as string, "Segnale pubblico Padova");
      if (hasPII(String(r.ai_summary ?? "")) || hasPII(JSON.stringify(r.payload ?? {}))) {
        bump("offmarket_pii"); continue;
      }
      candidates.push({
        signal_type: mapped,
        source_name: String(r.source_name ?? "public_source"),
        source_url: url,
        event_date: null,
        area_or_microzone: title,
        property_hint: null,
        confidence: "media",
        privacy_safe: true,
        contains_personal_data: false,
        pii_redacted: true,
        legal_basis_note: "Pubblicazione su fonte istituzionale/PA o avviso pubblico ufficiale.",
        explanation: minimizeTitle(r.ai_summary as string, "Segnale pubblico aggregato."),
        dedupe_key: `off:${digest(url)}`,
        payload_minimized: { original_type: rawType },
      });
    }
  }

  // ── Dedupe + filtro privacy_safe finale ───────────────────────
  const byKey = new Map<string, BuiltSignal>();
  for (const c of candidates) {
    if (!c.privacy_safe || !c.pii_redacted || c.contains_personal_data) {
      bump("privacy_gate_failed"); continue;
    }
    if (!c.source_url) { bump("missing_source_url"); continue; }
    byKey.set(c.dedupe_key, c);
  }
  const unique = Array.from(byKey.values());

  const by_signal_type: Record<string, number> = {};
  for (const u of unique) by_signal_type[u.signal_type] = (by_signal_type[u.signal_type] ?? 0) + 1;

  let inserted = 0; let updated = 0;
  if (!opts.dryRun && unique.length) {
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200).map((c) => ({
        municipality: COMUNE,
        province: PROV,
        region: "veneto",
        signal_type: c.signal_type,
        source_name: c.source_name,
        source_url: c.source_url,
        event_date: c.event_date,
        area_or_microzone: c.area_or_microzone,
        property_hint: c.property_hint,
        confidence: c.confidence,
        privacy_safe: c.privacy_safe,
        contains_personal_data: c.contains_personal_data,
        pii_redacted: c.pii_redacted,
        legal_basis_note: c.legal_basis_note,
        explanation: c.explanation,
        dedupe_key: c.dedupe_key,
        payload_minimized: c.payload_minimized,
        is_active: true,
        updated_at: new Date().toISOString(),
      }));
      const { error, count } = await sb
        .from("legal_life_event_signals")
        .upsert(chunk, { onConflict: "dedupe_key", count: "exact" });
      if (error) warnings.push(`upsert:${error.message}`);
      else updated += count ?? chunk.length;
    }
    // Best-effort: deactivate stale rows for Padova not seen this run
    const keys = unique.map((u) => u.dedupe_key);
    if (keys.length) {
      await sb
        .from("legal_life_event_signals")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("municipality", COMUNE)
        .not("dedupe_key", "in", `(${keys.map((k) => `"${k.replace(/"/g, "")}"`).join(",")})`);
    }
    inserted = updated; // upsert: insert+update conflated by Supabase count
  }

  const samples = unique.slice(0, 5).map((u) => ({
    signal_type: u.signal_type,
    source_name: u.source_name,
    confidence: u.confidence,
    area: u.area_or_microzone,
    event_date: u.event_date,
    privacy_safe: u.privacy_safe,
    explanation: u.explanation,
  }));

  return {
    ok: true,
    dry_run: opts.dryRun === true,
    comune: COMUNE,
    sources_queried,
    found: candidates.length,
    inserted,
    updated,
    discarded: Object.values(discarded_reasons).reduce((a, b) => a + b, 0),
    needs_review: 0,
    discarded_reasons,
    by_signal_type,
    samples,
    warnings,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
  };
}
