import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, RefreshCw, Play, ShieldAlert } from "lucide-react";

interface ProviderStatus {
  provider: string;
  env_var: string;
  configured: boolean;
  key_preview: string;
  reachable: boolean;
  auth_valid: boolean;
  http_status: number | null;
  latency_ms: number;
  message: string;
  quota: Record<string, unknown>;
  last_success: { created_at: string; latency_ms: number; message: string; action: string | null } | null;
  last_error: { created_at: string; http_status: number | null; message: string; action: string | null } | null;
}

interface HealthResponse {
  ok: boolean;
  checked_at: string;
  providers: ProviderStatus[];
}

const TESTABLE = new Set(["openai", "perplexity", "firecrawl", "apify"]);

const LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  perplexity: "Perplexity",
  firecrawl: "Firecrawl",
  apify: "Apify",
};

function fmtTime(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function StatusBadge({ p }: { p: ProviderStatus }) {
  if (!p.configured) return <Badge variant="outline">Non configurato</Badge>;
  if (p.auth_valid) return <Badge className="bg-emerald-600 hover:bg-emerald-600">OK</Badge>;
  if (p.reachable) return <Badge variant="destructive">Auth/HTTP {p.http_status ?? "?"}</Badge>;
  return <Badge variant="destructive">Irraggiungibile</Badge>;
}

export default function ProviderDiagnosticsPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const { data: resp, error: err } = await supabase.functions.invoke<HealthResponse>("provider-diagnostics", {
      method: "GET",
    });
    setLoading(false);
    if (err) {
      setError(err.message || "Errore");
      return;
    }
    setData(resp);
  }

  async function runTest(provider: string) {
    setTesting(provider);
    const { data: resp, error: err } = await supabase.functions.invoke<{
      ok: boolean;
      provider: string;
      result: { ok: boolean; latency_ms: number; message: string; http_status?: number };
    }>("provider-diagnostics", {
      method: "POST",
      body: { provider },
    });
    setTesting(null);
    if (err) {
      toast({ title: `${LABELS[provider]} — errore`, description: err.message, variant: "destructive" });
      return;
    }
    const r = resp!.result;
    toast({
      title: `${LABELS[provider]} — ${r.ok ? "OK" : "FAIL"} in ${r.latency_ms}ms`,
      description: r.message,
      variant: r.ok ? "default" : "destructive",
    });
    // Refresh to surface last_success/last_error
    load();
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Diagnostica Provider</h1>
          <p className="text-sm text-muted-foreground">
            Healthcheck live e test attivi delle integrazioni esterne. Solo admin. Le chiavi non transitano mai dal client.
          </p>
        </div>
        <Button onClick={load} disabled={loading} variant="outline" size="sm">
          {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
          Ricontrolla
        </Button>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6 flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium">Impossibile caricare la diagnostica</p>
              <p className="text-muted-foreground">{error}</p>
              <p className="text-muted-foreground mt-1">Verifica di essere autenticato come admin.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {data?.checked_at && (
        <p className="text-xs text-muted-foreground">Ultimo controllo: {fmtTime(data.checked_at)}</p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {data?.providers.map((p) => {
          const canTest = TESTABLE.has(p.provider) && p.configured;
          const isTesting = testing === p.provider;
          return (
            <Card key={p.provider}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{LABELS[p.provider] ?? p.provider}</CardTitle>
                  <StatusBadge p={p} />
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-muted-foreground text-xs">Env</span>
                    <p className="font-mono text-xs">{p.env_var}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Chiave</span>
                    <p className="font-mono text-xs">{p.key_preview}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Latenza probe</span>
                    <p>{p.latency_ms} ms</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">HTTP</span>
                    <p>{p.http_status ?? "—"}</p>
                  </div>
                </div>

                <div>
                  <span className="text-muted-foreground text-xs">Messaggio</span>
                  <p className="text-xs">{p.message}</p>
                </div>

                {Object.keys(p.quota ?? {}).length > 0 && (
                  <div className="bg-secondary/40 rounded p-2">
                    <span className="text-muted-foreground text-xs">Quota / piano</span>
                    <pre className="text-xs font-mono mt-1 whitespace-pre-wrap break-all">
                      {JSON.stringify(p.quota, null, 2)}
                    </pre>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-1 text-xs">
                  <div>
                    <span className="text-muted-foreground">Ultimo successo:</span>{" "}
                    {p.last_success
                      ? `${fmtTime(p.last_success.created_at)} · ${p.last_success.latency_ms}ms · ${p.last_success.action ?? "probe"}`
                      : "—"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Ultimo errore:</span>{" "}
                    {p.last_error
                      ? `${fmtTime(p.last_error.created_at)} · HTTP ${p.last_error.http_status ?? "?"} · ${p.last_error.message.slice(0, 80)}`
                      : "—"}
                  </div>
                </div>

                {canTest && (
                  <Button
                    onClick={() => runTest(p.provider)}
                    disabled={isTesting}
                    size="sm"
                    variant="secondary"
                    className="w-full"
                  >
                    {isTesting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4 mr-2" />
                    )}
                    {p.provider === "openai" && "Test completion"}
                    {p.provider === "perplexity" && "Test search"}
                    {p.provider === "firecrawl" && "Test scrape"}
                    {p.provider === "apify" && "Test actor run"}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
