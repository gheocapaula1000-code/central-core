import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, RefreshCw, Clock, AlertTriangle, TrendingUp,
  Zap, CheckCircle2, XCircle, Timer, BarChart3, Stethoscope, Loader2, KeyRound,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from "recharts";
import { coreAdminFetch } from "@/lib/coreAdminFetch";

// ── Types ──────────────────────────────────────────────────────
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

interface TaskStats {
  calls: number;
  successes: number;
  avgLatencyMs: number;
}

interface MetricsData {
  uptime_seconds: number;
  total_calls: number;
  providers: Record<string, ProviderStats>;
  recent_errors: Array<{ provider: string; task: string; error: string; timestamp: string }>;
  tasks: Record<string, TaskStats>;
}

interface DiagResult {
  status: string;
  latencyMs: number;
  output?: string;
  error?: string;
}

interface DiagnosticsData {
  status: string;
  providers: Record<string, DiagResult>;
  time: string;
}

// ── Colors ─────────────────────────────────────────────────────
const PROVIDER_COLORS: Record<string, string> = {
  openai: "hsl(160 84% 39%)",
  anthropic: "hsl(263 70% 58%)",
  perplexity: "hsl(186 72% 48%)",
};

const PROVIDER_BG: Record<string, string> = {
  openai: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  anthropic: "bg-violet-500/10 text-violet-400 border-violet-500/20",
  perplexity: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
};

// ── Helpers ────────────────────────────────────────────────────
function formatUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Component ──────────────────────────────────────────────────
export default function MetricsPage() {
  // Diagnostic secret — local state only, NOT stored in localStorage
  const [diagSecret, setDiagSecret] = useState("");
  const [secretSubmitted, setSecretSubmitted] = useState(false);

  const [diagData, setDiagData] = useState<DiagnosticsData | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);

  const runDiagnostics = useCallback(async () => {
    setDiagLoading(true);
    setDiagError(null);
    setDiagData(null);
    try {
      const result = await coreAdminFetch<DiagnosticsData>("ai-core-run/diagnostics", { diagnosticSecret: diagSecret });
      setDiagData(result);
    } catch (e) {
      setDiagError((e as Error).message);
    } finally {
      setDiagLoading(false);
    }
  }, [diagSecret]);

  const fetchMetrics = useCallback(async (): Promise<MetricsData> => {
    return coreAdminFetch<MetricsData>("ai-core-run/metrics", { diagnosticSecret: diagSecret });
  }, [diagSecret]);

  const { data, isLoading, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["metrics", secretSubmitted],
    queryFn: fetchMetrics,
    refetchInterval: secretSubmitted ? 15_000 : false,
    enabled: secretSubmitted,
    retry: 1,
  });

  // ── Secret input (local, not global gate) ────────────────────
  if (!secretSubmitted) {
    return (
      <div className="space-y-6 max-w-md">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-cyan-400" /> Metrics
        </h1>
        <Card className="border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <KeyRound className="h-4 w-4" /> Chiave diagnostica
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Gli endpoint diagnostici richiedono una chiave dedicata per l'accesso.
            </p>
            <Input
              type="password"
              placeholder="Inserisci chiave diagnostica"
              value={diagSecret}
              onChange={(e) => setDiagSecret(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && diagSecret.trim()) setSecretSubmitted(true); }}
              className="font-mono text-sm"
            />
            <Button
              size="sm"
              disabled={!diagSecret.trim()}
              onClick={() => setSecretSubmitted(true)}
            >
              Accedi ai dati
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Loading / Error ──────────────────────────────────────────
  if (isLoading && !data) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-cyan-400" /> Metrics
        </h1>
        <div className="flex items-center gap-2 text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" /> Caricamento metriche...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-cyan-400" /> Metrics
        </h1>
        <Card className="border-destructive/30">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              <span className="text-sm">{(error as Error).message}</span>
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => refetch()}
                className="text-xs text-muted-foreground underline"
              >
                Riprova
              </button>
              <button
                onClick={() => { setSecretSubmitted(false); setDiagSecret(""); }}
                className="text-xs text-muted-foreground underline"
              >
                Cambia chiave
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  // ── Chart data ───────────────────────────────────────────────
  const providerNames = Object.keys(data.providers) as string[];
  const latencyChartData = providerNames.map((p) => ({
    name: p.charAt(0).toUpperCase() + p.slice(1),
    avg: data.providers[p].avgLatencyMs,
    p95: data.providers[p].p95LatencyMs,
    max: data.providers[p].maxLatencyMs,
  }));

  const callsChartData = providerNames
    .filter((p) => data.providers[p].calls > 0)
    .map((p) => ({
      name: p.charAt(0).toUpperCase() + p.slice(1),
      value: data.providers[p].calls,
      fill: PROVIDER_COLORS[p] || "hsl(var(--muted-foreground))",
    }));

  const taskChartData = Object.entries(data.tasks)
    .sort(([, a], [, b]) => b.calls - a.calls)
    .slice(0, 12)
    .map(([task, stats]) => ({
      name: task.length > 16 ? task.slice(0, 14) + "…" : task,
      calls: stats.calls,
      avgLatency: stats.avgLatencyMs,
    }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-cyan-400" /> Metrics
        </h1>
        <div className="flex items-center gap-3">
          {dataUpdatedAt > 0 && (
            <span className="text-xs text-muted-foreground">
              Aggiornato: {new Date(dataUpdatedAt).toLocaleTimeString("it-IT")}
            </span>
          )}
          <button
            onClick={runDiagnostics}
            disabled={diagLoading}
            className="flex items-center gap-1.5 rounded-md bg-primary/10 border border-primary/20 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
          >
            {diagLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Stethoscope className="h-3 w-3" />}
            {diagLoading ? "Testing..." : "Diagnostica"}
          </button>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors"
          >
            <RefreshCw className="h-3 w-3" /> Aggiorna
          </button>
        </div>
      </div>

      {/* Diagnostics results */}
      {(diagData || diagError) && (
        <Card className={diagData?.status === "all_providers_ok" ? "border-emerald-500/30" : "border-amber-500/30"}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Stethoscope className="h-4 w-4" /> Diagnostica Provider
              {diagData && (
                <Badge variant="outline" className={diagData.status === "all_providers_ok" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20"}>
                  {diagData.status === "all_providers_ok" ? "Tutti OK" : "Problemi"}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {diagError && (
              <div className="flex items-center gap-2 text-destructive text-sm">
                <AlertTriangle className="h-4 w-4" /> {diagError}
              </div>
            )}
            {diagData && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {Object.entries(diagData.providers).map(([name, result]) => (
                  <div key={name} className="flex items-start gap-3 rounded-lg border p-3">
                    <div className="mt-0.5">
                      {result.status === "ok" ? (
                        <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                      ) : (
                        <XCircle className="h-5 w-5 text-destructive" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm capitalize">{name}</p>
                      {result.status === "ok" ? (
                        <>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Latenza: <span className="font-mono text-foreground">{result.latencyMs}ms</span>
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            Output: <span className="font-mono text-foreground">{result.output}</span>
                          </p>
                        </>
                      ) : (
                        <p className="text-xs text-destructive/80 mt-0.5">{result.error}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {diagData && (
              <p className="text-[10px] text-muted-foreground mt-3">
                Eseguito: {new Date(diagData.time).toLocaleString("it-IT")}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Top stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Totale Chiamate</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{data.total_calls}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Uptime Isolate</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{formatUptime(data.uptime_seconds)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Fallback Attivati</CardTitle>
            <Zap className="h-4 w-4 text-amber-400" />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{data.providers.anthropic?.fallbackCount ?? 0}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Errori Recenti</CardTitle>
            <AlertTriangle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{data.recent_errors.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Provider cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {providerNames.map((p) => {
          const s = data.providers[p];
          return (
            <Card key={p} className="overflow-hidden">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full`} style={{ backgroundColor: PROVIDER_COLORS[p] }} />
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </span>
                  <Badge variant="outline" className={PROVIDER_BG[p]}>
                    {s.successRate}%
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs">Chiamate</p>
                    <p className="font-mono font-semibold">{s.calls}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Successi / Errori</p>
                    <p className="font-mono font-semibold flex items-center gap-1.5">
                      <CheckCircle2 className="h-3 w-3 text-emerald-400" />{s.successes}
                      <XCircle className="h-3 w-3 text-destructive ml-1" />{s.failures}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Latenza Media</p>
                    <p className="font-mono font-semibold">{s.avgLatencyMs}ms</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Latenza P95</p>
                    <p className="font-mono font-semibold">{s.p95LatencyMs}ms</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Output Medio</p>
                    <p className="font-mono font-semibold">{s.avgOutputChars} chars</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Ultima Chiamata</p>
                    <p className="font-mono font-semibold text-xs">
                      {s.lastCallAt ? formatTime(s.lastCallAt) : "—"}
                    </p>
                  </div>
                </div>

                {/* Success rate bar */}
                <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${s.successRate}%`,
                      backgroundColor: s.successRate >= 90 ? "hsl(160 84% 39%)" : s.successRate >= 70 ? "hsl(38 92% 50%)" : "hsl(0 84% 60%)",
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Latency chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Timer className="h-4 w-4" /> Latenza per Provider
            </CardTitle>
          </CardHeader>
          <CardContent>
            {latencyChartData.some((d) => d.avg > 0) ? (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={latencyChartData} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 4% 20%)" />
                  <XAxis dataKey="name" tick={{ fill: "hsl(240 5% 55%)", fontSize: 12 }} />
                  <YAxis tick={{ fill: "hsl(240 5% 55%)", fontSize: 12 }} unit="ms" />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(240 5% 11%)", border: "1px solid hsl(240 4% 20%)", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: "hsl(0 0% 95%)" }}
                  />
                  <Bar dataKey="avg" name="Media" fill="hsl(186 72% 48%)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="p95" name="P95" fill="hsl(263 70% 58%)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="max" name="Max" fill="hsl(38 92% 50%)" radius={[4, 4, 0, 0]} />
                  <Legend wrapperStyle={{ fontSize: 11, color: "hsl(240 5% 55%)" }} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground py-8 text-center">Nessun dato di latenza disponibile</p>
            )}
          </CardContent>
        </Card>

        {/* Calls distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> Distribuzione Chiamate
            </CardTitle>
          </CardHeader>
          <CardContent>
            {callsChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={callsChartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={3}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}`}
                    labelLine={false}
                  >
                    {callsChartData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(240 5% 11%)", border: "1px solid hsl(240 4% 20%)", borderRadius: 8, fontSize: 12 }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground py-8 text-center">Nessuna chiamata registrata</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Task breakdown */}
      {taskChartData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4" /> Chiamate per Task
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={taskChartData} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 4% 20%)" />
                <XAxis type="number" tick={{ fill: "hsl(240 5% 55%)", fontSize: 11 }} />
                <YAxis dataKey="name" type="category" width={120} tick={{ fill: "hsl(240 5% 55%)", fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(240 5% 11%)", border: "1px solid hsl(240 4% 20%)", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "hsl(0 0% 95%)" }}
                />
                <Bar dataKey="calls" name="Chiamate" fill="hsl(186 72% 48%)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Recent errors */}
      {data.recent_errors.length > 0 && (
        <Card className="border-destructive/20">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" /> Errori Recenti
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-64 overflow-auto">
              {data.recent_errors.slice().reverse().map((err, i) => (
                <div key={i} className="flex items-start gap-3 text-sm border-b border-border/50 pb-2 last:border-0">
                  <Badge variant="outline" className={`shrink-0 text-[10px] ${PROVIDER_BG[err.provider] || ""}`}>
                    {err.provider}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs text-muted-foreground">{err.task}</p>
                    <p className="text-xs text-destructive/80 truncate">{err.error}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {formatTime(err.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
