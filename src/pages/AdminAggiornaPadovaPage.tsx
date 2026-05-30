import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw, Database, PlayCircle } from "lucide-react";
import { toast } from "sonner";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

interface ReadinessData {
  score?: number;
  missing?: string[];
  required_actions?: string[];
  evidence_counts?: Record<string, number>;
  last_successful_ingestion_at?: string | null;
  [k: string]: unknown;
}

interface BackfillData {
  area_opportunity_scores?: number;
  deal_listings?: number;
  deal_auctions?: number;
  total?: number;
  [k: string]: unknown;
}

interface StageSummary {
  stage: string;
  ok: boolean;
  status: number;
  duration_ms: number;
  summary?: Record<string, unknown>;
  error?: string;
}

interface CycleReport {
  cycle_ok?: boolean;
  dry_run?: boolean;
  total_duration_ms?: number;
  stages?: StageSummary[];
  notes?: string[];
}

interface ProxyResponse {
  ok: boolean;
  invoked_by?: string;
  request_body?: { dryRun?: boolean; includeNeedsReview?: boolean };
  cycle_status?: number;
  cycle_error?: string | null;
  cycle_report?: { data?: CycleReport; warnings?: string[]; debug_id?: string; error?: { message: string } } | CycleReport | string | null;
  duration_ms?: number;
  error?: string;
}

function extractCycle(resp: ProxyResponse): { cycle: CycleReport | null; warnings: string[] } {
  const r = resp.cycle_report;
  if (r && typeof r === "object" && "data" in r && r.data && typeof r.data === "object") {
    return { cycle: r.data as CycleReport, warnings: (r as { warnings?: string[] }).warnings ?? [] };
  }
  if (r && typeof r === "object" && "stages" in r) {
    return { cycle: r as CycleReport, warnings: [] };
  }
  return { cycle: null, warnings: [] };
}

export default function AdminAggiornaPadovaPage() {
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<ProxyResponse | null>(null);

  const run = async () => {
    setRunning(true);
    setResponse(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        toast.error("Sessione scaduta, effettua di nuovo il login.");
        return;
      }
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/padova-bootstrap-admin`;
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ dryRun: false, includeNeedsReview: true }),
      });
      const json = (await r.json().catch(() => ({}))) as ProxyResponse;
      setResponse(json);
      if (json.ok) toast.success("Orchestratore eseguito");
      else toast.error(json.error || "Esecuzione fallita");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg);
      setResponse({ ok: false, error: msg });
    } finally {
      setRunning(false);
    }
  };

  // ─────────── Pannello Dati Padova ───────────
  const [readiness, setReadiness] = useState<ReadinessData | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillResponse, setBackfillResponse] = useState<{
    ok: boolean;
    backfill_report?: { data?: BackfillData; error?: { message: string } };
    error?: string;
  } | null>(null);

  const getToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, []);

  const loadReadiness = useCallback(async () => {
    setReadinessLoading(true);
    setReadinessError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Sessione scaduta");
      const r = await fetch(`${SUPABASE_URL}/functions/v1/civiko-agency-data-readiness`, {
        method: "GET",
        headers: {
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${token}`,
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      setReadiness((j?.data ?? j) as ReadinessData);
    } catch (e) {
      setReadinessError(e instanceof Error ? e.message : String(e));
    } finally {
      setReadinessLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    loadReadiness();
  }, [loadReadiness]);

  const runBackfill = async () => {
    setBackfillRunning(true);
    setBackfillResponse(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Sessione scaduta");
      const r = await fetch(`${SUPABASE_URL}/functions/v1/civiko-force-backfill-admin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      setBackfillResponse(j);
      if (j.ok) {
        toast.success("Evidence sincronizzata");
        loadReadiness();
      } else {
        toast.error(j.error || j?.backfill_report?.error?.message || "Backfill fallito");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg);
      setBackfillResponse({ ok: false, error: msg });
    } finally {
      setBackfillRunning(false);
    }
  };

  const scoreVariant = (score?: number) => {
    if (score === undefined || score === null) return "outline";
    if (score >= 80) return "default";
    if (score >= 40) return "secondary";
    return "destructive";
  };
  const scoreClass = (score?: number) => {
    if (score === undefined || score === null) return "";
    if (score >= 80) return "bg-emerald-600 hover:bg-emerald-600";
    if (score >= 40) return "bg-amber-500 hover:bg-amber-500 text-black";
    return "";
  };

  const backfillData: BackfillData | undefined = backfillResponse?.backfill_report?.data;

  const { cycle, warnings } = response ? extractCycle(response) : { cycle: null, warnings: [] };
  const dryRunWarning = warnings.includes("dry_run_mode_real_build_skipped");

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Aggiorna intelligence Padova</h1>
        <p className="text-sm text-muted-foreground">
          Esegue l'orchestratore <code>padova-bootstrap-cycle</code> in modalità reale
          ({" "}<code>dryRun:false, includeNeedsReview:true</code>{" "}). Il segreto diagnostico
          resta lato server e non viene mai esposto al browser.
        </p>
      </div>

      {/* ─── Pannello Dati Padova ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            Pannello Dati Padova — Stato
            {readiness?.score !== undefined && (
              <Badge variant={scoreVariant(readiness.score)} className={scoreClass(readiness.score)}>
                score {readiness.score}/100
              </Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={loadReadiness}
              disabled={readinessLoading}
            >
              {readinessLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </CardTitle>
          <CardDescription>
            Letto in tempo reale da <code>civiko-agency-data-readiness</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {readinessError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
              {readinessError}
            </div>
          )}
          {readiness && (
            <>
              {readiness.last_successful_ingestion_at && (
                <div className="text-xs text-muted-foreground">
                  Ultima ingestione riuscita: {new Date(readiness.last_successful_ingestion_at).toLocaleString()}
                </div>
              )}
              {readiness.evidence_counts && (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(readiness.evidence_counts).map(([k, v]) => (
                    <Badge key={k} variant="outline">{k}: {v}</Badge>
                  ))}
                </div>
              )}
              {readiness.missing && readiness.missing.length > 0 && (
                <div>
                  <div className="font-medium text-xs mb-1">Missing</div>
                  <ul className="list-disc list-inside text-xs text-muted-foreground">
                    {readiness.missing.map((m, i) => <li key={i}>{m}</li>)}
                  </ul>
                </div>
              )}
              {readiness.required_actions && readiness.required_actions.length > 0 && (
                <div>
                  <div className="font-medium text-xs mb-1">Azioni richieste</div>
                  <ul className="list-disc list-inside text-xs text-muted-foreground">
                    {readiness.required_actions.map((m, i) => <li key={i}>{m}</li>)}
                  </ul>
                </div>
              )}
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Risposta completa</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2">
                  {JSON.stringify(readiness, null, 2)}
                </pre>
              </details>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PlayCircle className="h-5 w-5" />
            Sincronizza Evidence
          </CardTitle>
          <CardDescription>
            Esegue <code>civiko-force-backfill</code> via proxy admin. Lanciare dopo il bootstrap
            per consolidare deal, auction e area scores nel ledger evidence.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={runBackfill} disabled={backfillRunning} variant="secondary">
            {backfillRunning ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sincronizzazione…</>
            ) : (
              <><RefreshCw className="mr-2 h-4 w-4" /> Sincronizza Evidence</>
            )}
          </Button>
          {backfillResponse && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant={backfillResponse.ok ? "default" : "destructive"}>
                  {backfillResponse.ok ? "OK" : "ERRORE"}
                </Badge>
                {backfillData?.total !== undefined && (
                  <span className="text-xs text-muted-foreground">
                    Total evidence righe: {backfillData.total}
                  </span>
                )}
              </div>
              {backfillData && (
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="outline">area_opportunity_scores: {backfillData.area_opportunity_scores ?? 0}</Badge>
                  <Badge variant="outline">deal_listings: {backfillData.deal_listings ?? 0}</Badge>
                  <Badge variant="outline">deal_auctions: {backfillData.deal_auctions ?? 0}</Badge>
                </div>
              )}
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Risposta completa</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2">
                  {JSON.stringify(backfillResponse, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </CardContent>
      </Card>


      <Card>
        <CardHeader>
          <CardTitle>Avvio ciclo</CardTitle>
          <CardDescription>
            Aggrega auctions, advanced opportunities, early-warning e readiness per Padova.
            L'operazione è idempotente e può richiedere alcuni minuti.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={run} disabled={running}>
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                In esecuzione…
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Aggiorna intelligence Padova
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {response && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Report
              {response.ok ? (
                <Badge variant="default">OK</Badge>
              ) : (
                <Badge variant="destructive">ERRORE</Badge>
              )}
              {cycle?.dry_run !== undefined && (
                <Badge variant="outline">dryRun: {String(cycle.dry_run)}</Badge>
              )}
            </CardTitle>
            <CardDescription>
              {response.invoked_by && <>Invocato da {response.invoked_by} · </>}
              cycle_status {response.cycle_status} · durata totale {response.duration_ms} ms
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {dryRunWarning ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                ⚠ Warning <code>dry_run_mode_real_build_skipped</code> ancora presente.
              </div>
            ) : (
              <div className="rounded-md border border-emerald-600/40 bg-emerald-600/10 p-3 text-sm">
                ✓ Nessun warning <code>dry_run_mode_real_build_skipped</code>: build reale eseguito.
              </div>
            )}

            {warnings.length > 0 && (
              <div className="text-xs text-muted-foreground">
                Warnings: {warnings.join(", ")}
              </div>
            )}

            {cycle?.stages && cycle.stages.length > 0 && (
              <div className="space-y-3">
                {cycle.stages.map((s, i) => (
                  <div key={i} className="rounded-md border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium text-sm">{s.stage}</div>
                      <div className="flex items-center gap-2">
                        <Badge variant={s.ok ? "default" : "destructive"}>
                          {s.ok ? "ok" : "errore"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          HTTP {s.status} · {s.duration_ms} ms
                        </span>
                      </div>
                    </div>
                    {s.error && (
                      <div className="mt-2 text-xs text-destructive">{s.error}</div>
                    )}
                    {s.summary && (
                      <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                        {JSON.stringify(s.summary, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Risposta completa (JSON)
              </summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted p-2">
                {JSON.stringify(response, null, 2)}
              </pre>
            </details>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
