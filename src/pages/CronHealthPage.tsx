import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/hooks/use-toast";
import { AlertTriangle, RefreshCw, Loader2, Info } from "lucide-react";
import IngestionRunsSection from "@/components/cron-health/IngestionRunsSection";
import SourceRegistrySection from "@/components/cron-health/SourceRegistrySection";
import DerivedSignalsSection from "@/components/cron-health/DerivedSignalsSection";

const MAIN_JOB = "nightly-data-refresh-master";

type CronRow = {
  id: number;
  job_name: string;
  status: "started" | "success" | "failure" | string;
  http_status: number | null;
  response_excerpt: string | null;
  error_message: string | null;
  duration_ms: number | null;
  triggered_at: string;
  completed_at: string | null;
};

const dtFmt = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return dtFmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function StatusBadge({ status, stuck }: { status: string; stuck?: boolean }) {
  if (stuck) {
    return <Badge className="bg-orange-500 hover:bg-orange-500/90 text-white">Bloccato a metà</Badge>;
  }
  if (status === "success") {
    return <Badge className="bg-green-600 hover:bg-green-600/90 text-white">Success</Badge>;
  }
  if (status === "failure") {
    return <Badge variant="destructive">Failure</Badge>;
  }
  if (status === "started") {
    return <Badge variant="secondary">In corso</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

export default function CronHealthPage() {
  const navigate = useNavigate();
  const [authChecked, setAuthChecked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [rows, setRows] = useState<CronRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Server-side guard: verify admin role via has_role RPC
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (!uid) {
        if (!mounted) return;
        toast({ title: "Accesso riservato", description: "Devi essere autenticato come admin." });
        navigate("/", { replace: true });
        return;
      }
      const { data, error } = await supabase.rpc("has_role", { _user_id: uid, _role: "admin" });
      if (!mounted) return;
      if (error || !data) {
        toast({ title: "Accesso riservato", description: "Solo gli admin possono visualizzare questa pagina." });
        navigate("/", { replace: true });
        return;
      }
      setIsAdmin(true);
      setAuthChecked(true);
    })();
    return () => {
      mounted = false;
    };
  }, [navigate]);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error } = await supabase
      .from("cron_executions_log")
      .select("id, job_name, status, http_status, response_excerpt, error_message, duration_ms, triggered_at, completed_at")
      .eq("job_name", MAIN_JOB)
      .order("triggered_at", { ascending: false })
      .limit(20);
    if (error) {
      setError(error.message);
      setRows([]);
    } else {
      setRows((data ?? []) as CronRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isAdmin) fetchRows();
  }, [isAdmin, fetchRows]);

  if (!authChecked) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Verifica permessi…
      </div>
    );
  }

  const last = rows[0];
  const now = Date.now();
  const lastTriggered = last ? new Date(last.triggered_at).getTime() : null;
  const hoursSince = lastTriggered ? (now - lastTriggered) / 3_600_000 : null;
  const stuck =
    last?.status === "started" &&
    !last.completed_at &&
    now - new Date(last.triggered_at).getTime() > 10 * 60_000;
  const stale = hoursSince != null && hoursSince > 26;

  let statusText = "—";
  if (stuck) statusText = "Bloccato a metà";
  else if (last?.status === "success") statusText = "Partito correttamente";
  else if (last?.status === "failure") statusText = "Fallito";
  else if (last?.status === "started") statusText = "In corso";

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Salute Cron</h1>
          <p className="text-sm text-muted-foreground">
            Monitoraggio job <code className="text-xs">{MAIN_JOB}</code>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchRows} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Aggiorna
        </Button>
      </div>

      {stale && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Attenzione</AlertTitle>
          <AlertDescription>
            Il cron non gira da più di 26 ore (ultima esecuzione {hoursSince!.toFixed(1)}h fa).
            Il job dovrebbe partire ogni 24h alle 02:00 UTC.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Ultima esecuzione</CardTitle>
          <CardDescription>Stato corrente del job notturno</CardDescription>
        </CardHeader>
        <CardContent>
          {last ? (
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
              <div>
                <div className="text-xs uppercase text-muted-foreground mb-1">Data e ora</div>
                <div className="font-medium">{formatDate(last.triggered_at)}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground mb-1">Stato</div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={last.status} stuck={stuck} />
                  <span className="text-sm">{statusText}</span>
                </div>
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground mb-1">Durata</div>
                <div className="font-medium">{formatDuration(last.duration_ms)}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground mb-1">Freschezza</div>
                <div className="font-medium">
                  {hoursSince != null ? `${hoursSince.toFixed(1)}h fa` : "—"}
                </div>
              </div>
              {last.status === "failure" && last.error_message && (
                <div className="sm:col-span-2 md:col-span-4">
                  <Alert variant="destructive">
                    <AlertTitle>Errore</AlertTitle>
                    <AlertDescription className="break-words">{last.error_message}</AlertDescription>
                  </Alert>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">Nessuna esecuzione registrata.</div>
          )}
        </CardContent>
      </Card>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          Status <strong>'success'</strong> significa che il cron è partito e ha invocato lo
          scheduler. Per verificare che lo scheduler abbia effettivamente raccolto dati, controlla
          la pagina dei dati raccolti.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Ultime 20 esecuzioni</CardTitle>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="w-full overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data/ora</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Durata</TableHead>
                  <TableHead>HTTP</TableHead>
                  <TableHead>Errore</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      Nessun dato.
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((r) => {
                  const isStuck =
                    r.status === "started" &&
                    !r.completed_at &&
                    now - new Date(r.triggered_at).getTime() > 10 * 60_000;
                  const err = r.error_message ?? "";
                  const truncated = err.length > 80 ? err.slice(0, 80) + "…" : err;
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap">{formatDate(r.triggered_at)}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} stuck={isStuck} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDuration(r.duration_ms)}</TableCell>
                      <TableCell>{r.http_status ?? "—"}</TableCell>
                      <TableCell className="max-w-xs">
                        {err ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-destructive cursor-help text-xs">{truncated}</span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-md break-words">{err}</TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <IngestionRunsSection />
      <SourceRegistrySection />
      <DerivedSignalsSection />
    </div>
  );
}
