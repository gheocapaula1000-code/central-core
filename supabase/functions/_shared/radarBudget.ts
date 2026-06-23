// ═══════════════════════════════════════════════════════════════
// Radar Budget Manager (central-core)
//
// Multi-livello: mensile (hard cap), settimanale dinamico, giornaliero
// dinamico, per-run, per-provider. Pesi giorno della settimana:
//   lun=4 (full+3 soft)  mar..sab=1  dom=0  → tot pesi=9
//
// Hard cap default: 200 EUR/mese. Override via env RADAR_MONTHLY_BUDGET_EUR.
// Spesa: somma di radar_budget_ledger.estimated_cost_eur per month_key.
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export type BudgetMode = "normal" | "cautious" | "economy" | "capped";
export type RadarIntent = "soft" | "full" | "unknown";

export interface RadarRunMeta {
  run_id?: string;
  request_id?: string;
  source?: string;
  target?: string;
  triggered_by?: string;
  mode?: string;
  intent?: RadarIntent | string;
  scope?: string;
}

export interface BudgetState {
  enabled: boolean;
  budget_mode: BudgetMode;
  monthly_budget_eur: number;
  monthly_spent_eur: number;
  monthly_remaining_eur: number;
  weekly_budget_eur: number;
  weekly_spent_eur: number;
  daily_budget_eur: number;
  daily_spent_eur: number;
  run_budget_eur: number;
  run_spent_eur: number;
  provider_costs: Record<string, number>;
  warnings: string[];
  cost_report: Record<string, unknown>;
}

// ── Config ──────────────────────────────────────────────────────
const DEFAULT_MONTHLY_BUDGET_EUR = 200;
const DEFAULT_USD_TO_EUR = 0.92;
const DAY_WEIGHTS = [0, 1, 1, 1, 1, 1, 4]; // Sun..Sat (0..6), Mon=4
const WEIGHT_TOTAL_WEEKLY = DAY_WEIGHTS.reduce((a, b) => a + b, 0); // 9
// Soglie (frazioni del budget di riferimento)
const T_CAUTIOUS = Number(Deno.env.get("RADAR_BUDGET_WARN_THRESHOLD") ?? "0.70");
const T_ECONOMY = Number(Deno.env.get("RADAR_BUDGET_ECONOMY_THRESHOLD") ?? "0.85");
const T_CAPPED = Number(Deno.env.get("RADAR_BUDGET_CAP_THRESHOLD") ?? "0.95");
const T_HARD = Number(Deno.env.get("RADAR_BUDGET_HARD_CAP_THRESHOLD") ?? "1.00");

// Stime di costo per chiamata quando il provider non restituisce usage reale.
// Tutte in USD (poi convertite in EUR via USD_TO_EUR).
export const PROVIDER_COST_ESTIMATE_USD: Record<string, number> = {
  apify: 0.05,       // per actor run medio
  firecrawl: 0.001,  // per pagina
  perplexity: 0.005, // per query
  openai: 0.01,      // per chiamata media (token-based override raccomandato)
  lovable: 0.005,
};

function getMonthlyBudgetEur(): number {
  const raw = Deno.env.get("RADAR_MONTHLY_BUDGET_EUR");
  const n = raw ? Number(raw) : DEFAULT_MONTHLY_BUDGET_EUR;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MONTHLY_BUDGET_EUR;
}

function getUsdToEur(): number {
  const raw = Deno.env.get("RADAR_USD_TO_EUR");
  const n = raw ? Number(raw) : DEFAULT_USD_TO_EUR;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_TO_EUR;
}

function isEnabled(): boolean {
  const raw = (Deno.env.get("RADAR_BUDGET_ENABLE") ?? "true").toLowerCase();
  return raw !== "false" && raw !== "0";
}

function sb() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Date helpers (Europe/Rome semantics, UTC date keys) ─────────
function nowDate(): Date {
  return new Date();
}
export function monthKey(d = nowDate()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function dayKey(d = nowDate()): string {
  return d.toISOString().slice(0, 10);
}
export function weekKey(d = nowDate()): string {
  // ISO week (YYYY-Www)
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function daysInMonth(d = nowDate()): number {
  return new Date(d.getUTCFullYear(), d.getUTCMonth() + 1, 0).getUTCDate();
}
function daysRemainingInMonth(d = nowDate()): number {
  return daysInMonth(d) - d.getUTCDate() + 1;
}
function weightsRemainingInMonth(d = nowDate()): number {
  // Somma DAY_WEIGHTS per ogni giorno residuo del mese (incluso oggi)
  let sum = 0;
  const total = daysInMonth(d);
  for (let day = d.getUTCDate(); day <= total; day++) {
    const dow = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day)).getUTCDay();
    sum += DAY_WEIGHTS[dow];
  }
  return sum || 1;
}
function todayWeight(d = nowDate()): number {
  return DAY_WEIGHTS[d.getUTCDay()];
}

// ── Spend queries ───────────────────────────────────────────────
async function spendEurFor(filter: Record<string, string>): Promise<number> {
  const c = sb();
  if (!c) return 0;
  let q = c.from("radar_budget_ledger").select("estimated_cost_eur");
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { data } = await q;
  if (!data) return 0;
  // deno-lint-ignore no-explicit-any
  return (data as any[]).reduce((s, r) => s + Number(r?.estimated_cost_eur ?? 0), 0);
}

export async function getMonthSpentEur(d = nowDate()): Promise<number> {
  return await spendEurFor({ month_key: monthKey(d) });
}
export async function getDaySpentEur(d = nowDate()): Promise<number> {
  return await spendEurFor({ day_key: dayKey(d) });
}
export async function getWeekSpentEur(d = nowDate()): Promise<number> {
  return await spendEurFor({ week_key: weekKey(d) });
}
export async function getRunSpentEur(run_id: string): Promise<number> {
  if (!run_id) return 0;
  return await spendEurFor({ run_id });
}
export async function getRunProviderBreakdown(run_id: string): Promise<Record<string, number>> {
  const c = sb();
  if (!c || !run_id) return {};
  const { data } = await c
    .from("radar_budget_ledger")
    .select("provider, estimated_cost_eur")
    .eq("run_id", run_id);
  const out: Record<string, number> = {};
  // deno-lint-ignore no-explicit-any
  for (const r of (data as any[] ?? [])) {
    const p = String(r?.provider ?? "unknown");
    out[p] = (out[p] ?? 0) + Number(r?.estimated_cost_eur ?? 0);
  }
  return out;
}

// ── Mode selection ──────────────────────────────────────────────
function classifyMode(usedFraction: number): BudgetMode {
  if (usedFraction >= T_HARD) return "capped";
  if (usedFraction >= T_CAPPED) return "capped";
  if (usedFraction >= T_ECONOMY) return "economy";
  if (usedFraction >= T_CAUTIOUS) return "cautious";
  return "normal";
}

// ── Run budget helper ───────────────────────────────────────────
function runBudgetFromDay(dailyBudget: number, intent: RadarIntent | string): number {
  // Lunedì: full weekly riceve la maggior parte; soft del lunedì restano bassi.
  const t = nowDate();
  if (t.getUTCDay() === 1 /* Mon */) {
    // su lunedì pesi: full≈3, soft≈1 each (3 soft + 1 full = 6 unità nel giorno, ma DAY_WEIGHTS[Mon]=4)
    // Split: full=75%, soft=8.3% each (3*0.083=0.25)
    if (intent === "full") return dailyBudget * 0.75;
    return dailyBudget * (0.25 / 3);
  }
  // Altri giorni: 3 soft run → 1/3 ciascuno
  if (intent === "full") return dailyBudget; // edge case
  return dailyBudget / 3;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Costruisce un cost_report safe-default con shape completa e provider_costs
 * con tutte le chiavi obbligatorie (apify/firecrawl/perplexity/openai) a 0.
 * Usato come fallback quando computeBudgetState() fallisce o non viene chiamato.
 */
export function emptyCostReport(extraWarnings: string[] = []): Record<string, unknown> {
  const monthly = getMonthlyBudgetEur();
  return {
    budget_mode: "normal",
    monthly_budget_eur: monthly,
    monthly_spent_eur: 0,
    monthly_remaining_eur: monthly,
    weekly_budget_eur: 0,
    weekly_spent_eur: 0,
    daily_budget_eur: 0,
    daily_spent_eur: 0,
    run_budget_eur: 0,
    run_spent_eur: 0,
    provider_costs: { apify: 0, firecrawl: 0, perplexity: 0, openai: 0 },
    warnings: ["cost_report_fallback", ...extraWarnings],
    pacing: { day_weight: todayWeight(), weights_remaining_in_month: weightsRemainingInMonth(), eur_per_weight: 0 },
  };
}

/**
 * Normalizza un cost_report assicurando che tutti i campi obbligatori e
 * tutte le chiavi provider (apify/firecrawl/perplexity/openai) siano presenti.
 */
export function ensureCostReport(report?: Record<string, unknown> | null, extraWarnings: string[] = []): Record<string, unknown> {
  const base = emptyCostReport(extraWarnings);
  if (!report || typeof report !== "object") return base;
  const merged: Record<string, unknown> = { ...base, ...report };
  const pc = (report as Record<string, unknown>).provider_costs;
  const pcObj = (pc && typeof pc === "object") ? pc as Record<string, number> : {};
  merged.provider_costs = {
    apify: Number(pcObj.apify ?? 0),
    firecrawl: Number(pcObj.firecrawl ?? 0),
    perplexity: Number(pcObj.perplexity ?? 0),
    openai: Number(pcObj.openai ?? 0),
    ...pcObj,
  };
  if (!Array.isArray(merged.warnings)) merged.warnings = [];
  if (!merged.pacing || typeof merged.pacing !== "object") merged.pacing = base.pacing;
  return merged;
}

export async function computeBudgetState(meta: RadarRunMeta = {}): Promise<BudgetState> {
  const enabled = isEnabled();
  const monthly_budget_eur = getMonthlyBudgetEur();
  const intent = (meta.intent as RadarIntent | undefined) ?? "unknown";

  const monthly_spent_eur = enabled ? await getMonthSpentEur() : 0;
  const monthly_remaining_eur = Math.max(0, monthly_budget_eur - monthly_spent_eur);

  const weights_rem = weightsRemainingInMonth();
  const today_w = todayWeight();
  // weekly = quota di pesi corrispondenti alla settimana corrente (residua nel mese)
  // Approssimazione: distribuiamo monthly_remaining su weights_rem,
  // weekly_budget = somma dei pesi dei prossimi 7 giorni dentro il mese.
  const t = nowDate();
  let week_weights = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(t.getTime() + i * 86400000);
    if (d.getUTCMonth() !== t.getUTCMonth()) break;
    week_weights += DAY_WEIGHTS[d.getUTCDay()];
  }
  const eur_per_weight = monthly_remaining_eur / weights_rem;
  const weekly_budget_eur = eur_per_weight * week_weights;
  const daily_budget_eur = eur_per_weight * today_w;

  const weekly_spent_eur = enabled ? await getWeekSpentEur() : 0;
  const daily_spent_eur = enabled ? await getDaySpentEur() : 0;
  const run_spent_eur = enabled && meta.run_id ? await getRunSpentEur(meta.run_id) : 0;
  const provider_costs = enabled && meta.run_id
    ? await getRunProviderBreakdown(meta.run_id)
    : {};

  const run_budget_eur = runBudgetFromDay(daily_budget_eur, intent);

  // Mode = peggiore fra monthly, daily, run
  const fracMonth = monthly_budget_eur > 0 ? monthly_spent_eur / monthly_budget_eur : 0;
  const fracDay = daily_budget_eur > 0 ? daily_spent_eur / daily_budget_eur : 0;
  const fracRun = run_budget_eur > 0 ? run_spent_eur / run_budget_eur : 0;
  const fracMax = Math.max(fracMonth, fracDay, fracRun);
  const budget_mode = classifyMode(fracMax);

  const warnings: string[] = [];
  if (fracMonth >= T_HARD) warnings.push("monthly_hard_cap_reached");
  else if (fracMonth >= T_CAPPED) warnings.push("monthly_cap_near");
  if (fracDay >= T_CAPPED) warnings.push("daily_budget_near_cap");
  if (fracRun >= T_CAPPED) warnings.push("run_budget_near_cap");
  if (!enabled) warnings.push("budget_disabled");

  const cost_report = {
    budget_mode,
    monthly_budget_eur,
    monthly_spent_eur: Number(monthly_spent_eur.toFixed(4)),
    monthly_remaining_eur: Number(monthly_remaining_eur.toFixed(4)),
    weekly_budget_eur: Number(weekly_budget_eur.toFixed(4)),
    weekly_spent_eur: Number(weekly_spent_eur.toFixed(4)),
    daily_budget_eur: Number(daily_budget_eur.toFixed(4)),
    daily_spent_eur: Number(daily_spent_eur.toFixed(4)),
    run_budget_eur: Number(run_budget_eur.toFixed(4)),
    run_spent_eur: Number(run_spent_eur.toFixed(4)),
    provider_costs,
    warnings,
    pacing: {
      day_weight: today_w,
      weights_remaining_in_month: weights_rem,
      eur_per_weight: Number(eur_per_weight.toFixed(4)),
    },
  };

  return {
    enabled,
    budget_mode,
    monthly_budget_eur,
    monthly_spent_eur,
    monthly_remaining_eur,
    weekly_budget_eur,
    weekly_spent_eur,
    daily_budget_eur,
    daily_spent_eur,
    run_budget_eur,
    run_spent_eur,
    provider_costs,
    warnings,
    cost_report,
  };
}

export interface ProviderCallEstimate {
  provider: string;
  api_name?: string;
  operation?: string;
  estimated_cost_usd?: number;
  estimated_cost_eur?: number;
  items?: number;
}

export function estimateCostEur(p: ProviderCallEstimate): number {
  if (Number.isFinite(p.estimated_cost_eur) && (p.estimated_cost_eur ?? 0) > 0) {
    return p.estimated_cost_eur as number;
  }
  const usd = Number.isFinite(p.estimated_cost_usd) && (p.estimated_cost_usd ?? 0) > 0
    ? (p.estimated_cost_usd as number)
    : (PROVIDER_COST_ESTIMATE_USD[p.provider] ?? 0.01);
  return usd * getUsdToEur();
}

/**
 * Guard PRIMA della chiamata costosa. Restituisce { allowed, reason, mode }.
 * In modalità `capped`: blocca tutte le chiamate non essenziali.
 * In modalità `economy`: blocca se la stima farebbe sforare run/day budget.
 * In modalità `cautious`: lascia passare ma segnala.
 */
export async function canCallProvider(
  call: ProviderCallEstimate,
  meta: RadarRunMeta = {},
  opts: { essential?: boolean } = {},
): Promise<{ allowed: boolean; reason?: string; mode: BudgetMode; estimated_eur: number; state: BudgetState }> {
  const state = await computeBudgetState(meta);
  const estimated_eur = estimateCostEur(call);

  if (!state.enabled) {
    return { allowed: true, mode: state.budget_mode, estimated_eur, state };
  }

  // Hard cap mensile assoluto
  if (state.monthly_spent_eur + estimated_eur > state.monthly_budget_eur) {
    return { allowed: false, reason: "monthly_hard_cap_reached", mode: "capped", estimated_eur, state };
  }

  if (state.budget_mode === "capped" && !opts.essential) {
    return { allowed: false, reason: "budget_capped_skip", mode: state.budget_mode, estimated_eur, state };
  }

  // Per-run guard
  if (state.run_budget_eur > 0 && state.run_spent_eur + estimated_eur > state.run_budget_eur) {
    if (state.budget_mode === "economy" || state.budget_mode === "capped") {
      return { allowed: false, reason: "run_budget_reached", mode: state.budget_mode, estimated_eur, state };
    }
  }
  // Daily guard (solo blocco oltre il 100% del budget giornaliero)
  if (state.daily_budget_eur > 0 && state.daily_spent_eur + estimated_eur > state.daily_budget_eur * T_HARD) {
    if (state.budget_mode === "economy" || state.budget_mode === "capped") {
      return { allowed: false, reason: "daily_budget_reached", mode: state.budget_mode, estimated_eur, state };
    }
  }

  return { allowed: true, mode: state.budget_mode, estimated_eur, state };
}

export interface ProviderUsageRecord extends ProviderCallEstimate {
  calls_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  compute_units?: number;
  proxy_gb?: number;
  items_processed?: number;
  cost_basis?: "actual" | "estimate" | "mixed";
  metadata?: Record<string, unknown>;
}

/** Logga la chiamata effettiva nel ledger. Idempotente best-effort. */
export async function recordProviderUsage(
  usage: ProviderUsageRecord,
  meta: RadarRunMeta = {},
  budget_mode?: BudgetMode,
): Promise<void> {
  const c = sb();
  if (!c) return;
  const t = nowDate();
  const eur = estimateCostEur(usage);
  const usd = Number.isFinite(usage.estimated_cost_usd) && (usage.estimated_cost_usd ?? 0) > 0
    ? (usage.estimated_cost_usd as number)
    : eur / Math.max(getUsdToEur(), 0.0001);
  try {
    await c.from("radar_budget_ledger").insert({
      run_id: meta.run_id ?? null,
      request_id: meta.request_id ?? null,
      source: meta.source ?? "central-core",
      target: meta.target ?? "civiko-one",
      triggered_by: meta.triggered_by ?? null,
      mode: meta.mode ?? null,
      intent: meta.intent ?? null,
      scope: meta.scope ?? null,
      provider: usage.provider,
      api_name: usage.api_name ?? null,
      operation: usage.operation ?? null,
      calls_count: usage.calls_count ?? 1,
      items_processed: usage.items_processed ?? usage.items ?? 0,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      compute_units: usage.compute_units ?? 0,
      proxy_gb: usage.proxy_gb ?? 0,
      estimated_cost_eur: Number(eur.toFixed(6)),
      estimated_cost_usd: Number(usd.toFixed(6)),
      cost_basis: usage.cost_basis ?? "estimate",
      budget_mode: budget_mode ?? null,
      month_key: monthKey(t),
      week_key: weekKey(t),
      day_key: dayKey(t),
      metadata: usage.metadata ?? {},
    });
  } catch (e) {
    console.warn("[radarBudget] ledger insert failed:", e instanceof Error ? e.message : String(e));
  }
}

/** True quando il cap mensile EUR è raggiunto (kill-switch trasversale). */
export async function isRadarMonthlyHardCapReached(): Promise<boolean> {
  if (!isEnabled()) return false;
  const spent = await getMonthSpentEur();
  return spent >= getMonthlyBudgetEur();
}
