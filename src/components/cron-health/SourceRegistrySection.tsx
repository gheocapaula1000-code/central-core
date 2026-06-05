import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { AlertTriangle, Loader2 } from "lucide-react";

type SourceRow = {
  source_code: string;
  source_name: string | null;
  automation_status: string | null;
  implementation_status: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  next_run_at: string | null;
  record_count: number | null;
  scheduler_frequency: string | null;
  updated_at: string | null;
};

const dtFmt = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const numFmt = new Intl.NumberFormat("it-IT");

const INACTIVE_STATUSES = new Set(["disabled", "manual_fallback", "premium_on_demand"]);

function formatDate(iso: string | null): string {
  if (!iso) return "Mai";
  try {
    return dtFmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

function AutomationBadge({ status }: { status: string | null }) {
  const s = (status ?? "").toLowerCase();
  if (s === "enabled" || s === "active" || s === "scheduled") {
    return <Badge className="bg-green-600 hover:bg-green-600/90 text-white">{status}</Badge>;
  }
  if (s === "manual_fallback") {
    return <Badge className="bg-orange-500 hover:bg-orange-500/90 text-white">{status}</Badge>;
  }
  if (s === "premium_on_demand") {
    return <Badge className="bg-purple-600 hover:bg-purple-600/90 text-white">{status}</Badge>;
  }
  if (!status || s === "disabled") {
    return <Badge variant="secondary">{status ?? "—"}</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

export default function SourceRegistrySection() {
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPermissionDenied(false);
    const { data, error } = await supabase
      .from("civiko_source_registry")
      .select(
        "source_code, source_name, automation_status, implementation_status, last_run_at, last_success_at, last_error, next_run_at, record_count, scheduler_frequency, updated_at",
      )
      .order("last_run_at", { ascending: false, nullsFirst: false })
      .limit(500);
    if (error) {
      if (/permission|denied|rls|policy/i.test(error.message || "")) {
        setPermissionDenied(true);
      } else {
        setError(error.message);
      }
      setRows([]);
    } else {
      setRows((data ?? []) as SourceRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  if (permissionDenied) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Stato fonti dati</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>Permessi insufficienti su civiko_source_registry.</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const total = rows.length;
  const neverRun = rows.filter((r) => !r.last_run_at).length;
  const inError = rows.filter((r) => !!r.last_error).length;
  const active = rows.filter(
    (r) => r.automation_status && !INACTIVE_STATUSES.has(r.automation_status.toLowerCase()),
  ).length;

  const noneActiveScheduled =
    total > 0 &&
    rows.every(
      (r) =>
        !r.automation_status ||
        INACTIVE_STATUSES.has(r.automation_status.toLowerCase()) ||
        !r.last_run_at,
    );

  const activeWithErrors = rows.filter(
    (r) =>
      r.automation_status &&
      !INACTIVE_STATUSES.has(r.automation_status.toLowerCase()) &&
      !!r.last_error,
  ).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stato fonti dati</CardTitle>
        <CardDescription>
          Registro completo da <code className="text-xs">civiko_source_registry</code>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && (
          <div className="flex items-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Caricamento…
          </div>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
          {[
            { label: "Fonti totali", value: total },
            { label: "Mai eseguite", value: neverRun },
            { label: "In errore", value: inError },
            { label: "Attive", value: active },
          ].map((c) => (
            <Card key={c.label} className="bg-muted/40">
              <CardContent className="pt-6">
                <div className="text-xs uppercase text-muted-foreground mb-1">{c.label}</div>
                <div className="text-2xl font-bold">{numFmt.format(c.value)}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        {noneActiveScheduled && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Nessuna fonte attiva e schedulata</AlertTitle>
            <AlertDescription>
              Il cron parte ma non ha fonti da eseguire. Per questo ingestion_runs è vuota.
            </AlertDescription>
          </Alert>
        )}
        {!noneActiveScheduled && activeWithErrors > 0 && (
          <Alert className="border-orange-500/50 text-orange-700 dark:text-orange-400 [&>svg]:text-orange-500">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {activeWithErrors} fonti attive hanno generato errori nell'ultima esecuzione.
            </AlertDescription>
          </Alert>
        )}

        <div className="w-full overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Codice</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Stato automazione</TableHead>
                <TableHead>Ultima esecuzione</TableHead>
                <TableHead>Ultimo successo</TableHead>
                <TableHead className="text-right">Record</TableHead>
                <TableHead>Ultimo errore</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    Nessuna fonte registrata.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => {
                const err = r.last_error ?? "";
                const truncated = err.length > 60 ? err.slice(0, 60) + "…" : err;
                return (
                  <TableRow key={r.source_code}>
                    <TableCell className="whitespace-nowrap text-xs font-mono">
                      {r.source_code}
                    </TableCell>
                    <TableCell className="text-sm">{r.source_name ?? "—"}</TableCell>
                    <TableCell>
                      <AutomationBadge status={r.automation_status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDate(r.last_run_at)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDate(r.last_success_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      {numFmt.format(r.record_count ?? 0)}
                    </TableCell>
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
  );
}
