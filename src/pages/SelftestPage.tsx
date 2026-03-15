import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Play, CheckCircle2, AlertTriangle, XCircle, ShieldCheck } from "lucide-react";
import { coreAdminFetch } from "@/lib/coreAdminFetch";

interface SelftestResult {
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
  mode?: "reale" | "simulato" | "dry-run";
  buckets?: string[];
}

interface SelftestReport {
  overall: "PASS" | "WARN" | "FAIL";
  summary: { pass: number; warn: number; fail: number; total: number };
  tests: SelftestResult[];
  config: { rate_window_ms: number; rate_max_trusted: number; rate_max_public: number };
  version: string;
  timestamp: string;
}

const statusIcon = (s: "PASS" | "WARN" | "FAIL") => {
  if (s === "PASS") return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
  if (s === "WARN") return <AlertTriangle className="h-5 w-5 text-amber-500" />;
  return <XCircle className="h-5 w-5 text-red-500" />;
};

const statusBadge = (s: "PASS" | "WARN" | "FAIL") => {
  const variant = s === "PASS" ? "default" : s === "WARN" ? "secondary" : "destructive";
  return <Badge variant={variant}>{s}</Badge>;
};

const modeBadge = (mode?: "reale" | "simulato" | "dry-run") => {
  if (!mode) return null;
  const colors: Record<string, string> = {
    reale: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    simulato: "bg-sky-500/15 text-sky-400 border-sky-500/30",
    "dry-run": "bg-amber-500/15 text-amber-400 border-amber-500/30",
  };
  return <Badge variant="outline" className={`text-[10px] ${colors[mode]}`}>{mode}</Badge>;
};

export default function SelftestPage() {
  const [report, setReport] = useState<SelftestReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagSecret, setDiagSecret] = useState("");

  const runSelftest = async () => {
    if (!diagSecret.trim()) {
      setError("Inserisci il secret diagnostico (DIAGNOSTIC_SELFTEST_SECRET)");
      return;
    }
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const url = `https://${projectId}.supabase.co/functions/v1/ai-core-run/__diagnostics/selftest`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "x-internal-secret": diagSecret,
          "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
      });
      const json = await res.json();
      if (json.ok && json.data) {
        setReport(json.data as SelftestReport);
      } else {
        setError(json.error?.message || `HTTP ${res.status}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Self-Test Diagnostico</h1>
      </div>

      <Card className="border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">Esegui selftest del Core</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="DIAGNOSTIC_SELFTEST_SECRET"
              value={diagSecret}
              onChange={(e) => setDiagSecret(e.target.value)}
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button onClick={runSelftest} disabled={loading} size="sm">
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Play className="h-4 w-4 mr-1" />}
              Esegui
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {report && (
        <>
          <Card className="border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold text-foreground">Risultato</CardTitle>
                {statusBadge(report.overall)}
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4 text-center text-sm">
                <div>
                  <div className="text-2xl font-bold text-emerald-500">{report.summary.pass}</div>
                  <div className="text-muted-foreground">Pass</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-amber-500">{report.summary.warn}</div>
                  <div className="text-muted-foreground">Warn</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-red-500">{report.summary.fail}</div>
                  <div className="text-muted-foreground">Fail</div>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground font-mono">
                <span>v{report.version}</span>
                <span>{new Date(report.timestamp).toLocaleString("it-IT")}</span>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-2">
            {report.tests.map((test, i) => (
              <Card key={i} className="border-border">
                <CardContent className="py-3 px-4">
                  <div className="flex items-start gap-3">
                    {statusIcon(test.status)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm text-foreground">{test.name}</span>
                        {statusBadge(test.status)}
                        {modeBadge(test.mode)}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 font-mono break-all">{test.detail}</p>
                      {test.buckets && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {test.buckets.map((b, j) => (
                            <Badge key={j} variant="outline" className="text-[10px] font-mono">{b}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Configurazione Rate Limiter</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4 text-sm font-mono">
                <div><span className="text-muted-foreground">Window:</span> <span className="text-foreground">{report.config.rate_window_ms}ms</span></div>
                <div><span className="text-muted-foreground">Trusted:</span> <span className="text-foreground">{report.config.rate_max_trusted}/min</span></div>
                <div><span className="text-muted-foreground">Public:</span> <span className="text-foreground">{report.config.rate_max_public}/min</span></div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
