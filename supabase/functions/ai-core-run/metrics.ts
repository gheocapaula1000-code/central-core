// ═══════════════════════════════════════════════════════════════
// Structured metrics for AI provider monitoring
// In-memory, per-isolate. Resets on cold start (edge function lifecycle).
// ═══════════════════════════════════════════════════════════════

export type ProviderName = "openai" | "anthropic" | "perplexity";

interface CallRecord {
  provider: ProviderName;
  task: string;
  domain: string;
  latencyMs: number;
  outputLen: number;
  inputLen: number;
  maxTokens: number;
  success: boolean;
  error?: string;
  timestamp: number;
}

interface ProviderStats {
  calls: number;
  successes: number;
  failures: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  totalOutputChars: number;
  avgOutputChars: number;
  successRate: number;
  lastCallAt: string | null;
  fallbackCount: number;
}

interface MetricsSnapshot {
  uptime_seconds: number;
  total_calls: number;
  providers: Record<ProviderName, ProviderStats>;
  recent_errors: Array<{ provider: ProviderName; task: string; error: string; timestamp: string }>;
  tasks: Record<string, { calls: number; successes: number; avgLatencyMs: number }>;
}

const MAX_HISTORY = 500;
const MAX_ERRORS = 50;
const history: CallRecord[] = [];
const recentErrors: Array<{ provider: ProviderName; task: string; error: string; timestamp: number }> = [];
let fallbackCount = 0;
const startedAt = Date.now();

/** Record a provider call result */
export function recordCall(opts: {
  provider: ProviderName;
  task: string;
  domain: string;
  latencyMs: number;
  outputLen: number;
  inputLen: number;
  maxTokens: number;
  success: boolean;
  error?: string;
}): void {
  const record: CallRecord = { ...opts, timestamp: Date.now() };
  history.push(record);
  if (history.length > MAX_HISTORY) history.shift();

  if (!opts.success && opts.error) {
    recentErrors.push({ provider: opts.provider, task: opts.task, error: opts.error, timestamp: Date.now() });
    if (recentErrors.length > MAX_ERRORS) recentErrors.shift();
  }

  // Structured log line (JSON for easy parsing by log aggregators)
  const logEntry = {
    _type: "ai_metric",
    provider: opts.provider,
    task: opts.task || "generic",
    domain: opts.domain,
    latency_ms: opts.latencyMs,
    output_len: opts.outputLen,
    input_len: opts.inputLen,
    max_tokens: opts.maxTokens,
    success: opts.success,
    ...(opts.error ? { error: opts.error.slice(0, 200) } : {}),
  };
  console.log(JSON.stringify(logEntry));
}

/** Record that a fallback was triggered (primary → secondary provider) */
export function recordFallback(): void {
  fallbackCount++;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function buildProviderStats(provider: ProviderName): ProviderStats {
  const calls = history.filter((r) => r.provider === provider);
  const successes = calls.filter((r) => r.success);
  const failures = calls.filter((r) => !r.success);
  const latencies = successes.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalLatency = latencies.reduce((a, b) => a + b, 0);
  const totalOutput = successes.reduce((a, r) => a + r.outputLen, 0);
  const lastCall = calls.length > 0 ? calls[calls.length - 1] : null;

  return {
    calls: calls.length,
    successes: successes.length,
    failures: failures.length,
    totalLatencyMs: totalLatency,
    avgLatencyMs: latencies.length > 0 ? Math.round(totalLatency / latencies.length) : 0,
    p95LatencyMs: percentile(latencies, 95),
    minLatencyMs: latencies.length > 0 ? latencies[0] : 0,
    maxLatencyMs: latencies.length > 0 ? latencies[latencies.length - 1] : 0,
    totalOutputChars: totalOutput,
    avgOutputChars: successes.length > 0 ? Math.round(totalOutput / successes.length) : 0,
    successRate: calls.length > 0 ? Math.round((successes.length / calls.length) * 10000) / 100 : 0,
    lastCallAt: lastCall ? new Date(lastCall.timestamp).toISOString() : null,
    fallbackCount: provider === "anthropic" ? fallbackCount : 0,
  };
}

/** Get full metrics snapshot */
export function getMetrics(): MetricsSnapshot {
  // Task-level aggregation
  const taskMap = new Map<string, { calls: number; successes: number; totalLatency: number }>();
  for (const r of history) {
    const key = r.task || "generic";
    const t = taskMap.get(key) ?? { calls: 0, successes: 0, totalLatency: 0 };
    t.calls++;
    if (r.success) { t.successes++; t.totalLatency += r.latencyMs; }
    taskMap.set(key, t);
  }
  const tasks: Record<string, { calls: number; successes: number; avgLatencyMs: number }> = {};
  for (const [key, val] of taskMap) {
    tasks[key] = {
      calls: val.calls,
      successes: val.successes,
      avgLatencyMs: val.successes > 0 ? Math.round(val.totalLatency / val.successes) : 0,
    };
  }

  return {
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    total_calls: history.length,
    providers: {
      openai: buildProviderStats("openai"),
      anthropic: buildProviderStats("anthropic"),
      perplexity: buildProviderStats("perplexity"),
    },
    recent_errors: recentErrors.slice(-20).map((e) => ({
      ...e,
      timestamp: new Date(e.timestamp).toISOString(),
    })),
    tasks,
  };
}
