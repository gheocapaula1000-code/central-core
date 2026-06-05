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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AlertTriangle, ChevronDown, Loader2 } from "lucide-react";

type IngestionRun = {
  id: number;
  job_name: string | null;
  source_name: string | null;
  status: string | null;
  rows_in: number | null;
  rows_out: number | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  errors: unknown;
  warnings: unknown;
  report: unknown;
};

const dayFmt = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const timeFmt = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  hour: "2-digit",
  minute: "2-digit",
});

const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const numFmt = new Intl.NumberFormat("it-IT");

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function StatusBadge({ status }: { status: string | null }) {
  const s = (status ?? "").toLowerCase();
  if (s === "completed" || s === "success" || s === "ok") {
    return <Badge className="bg-green-600 hover:bg-green-600/90 text-white">Completed</Badge>;
  }
  if (s === "completed_with_errors" || s === "partial") {
    return <Badge className="bg-orange-500 hover:bg-orange-500/90 text-white">Con errori</Badge>;
  }
  if (s === "failed" || s === "error" || s === "failure") {
    return <Badge variant="destructive">Failed</Badge>;
  }
  if (s === "running" || s === "started") {
    return <Badge variant="secondary">In corso</Badge>;
  }
  return <Badge variant="outline">{status ?? "—"}</Badge>;
}

type DailyAgg = {
  dayKey: string; // YYYY-MM-DD in Rome
  dayLabel: string;
  rowsOut: number;
  totalRuns: number;
  problemRuns: number;
  sampleDate: Date;
};

function aggregateByDay(rows: IngestionRun[]): DailyAgg[] {
  const map = new Map<string, DailyAgg>();
  for (const r of rows) {
    const d = new Date(r.started_at);
    const key = dayKeyFmt.format(d);
    const existing = map.get(key);
    const rowsOut = r.rows_out ?? 0;
    const s = (r.status ?? "").toLowerCase();
    const isProblem = s !== "completed" && s !== "success" && s !== "ok";
    if (existing) {
      existing.rowsOut += rowsOut;
      existing.totalRuns += 1;
      if (isProblem) existing.problemRuns += 1;
    } else {
      map.set(key, {
        dayKey: key,
        dayLabel: dayFmt.format(d),
        rowsOut,
        totalRuns: 1,
        problemRuns: isProblem ? 1 : 0,
        sampleDate: d,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1));
}

function ErrorsCell({ errors }: { errors: unknown }) {
  const [open, setOpen] = useState(false);
  if (errors == null) return <span className="text-muted-foreground">—</span>;
  let pretty = "";
  try {
    pretty = JSON.stringify(errors, null, 2);
  } catch {
    pretty = String(errors);
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="inline-flex items-center gap-1 text-destructive hover:underline text-xs">
        <AlertTriangle className="h-3.5 w-3.5" />
        Errori
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-2 max-w-md whitespace-pre-wrap break-words rounded bg-muted p-2 text-[11px] leading-snug">
          {pretty}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function IngestionRunsSection() {
  const [rows, setRows] = useState<IngestionRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPermissionDenied(false);
    const sinceIso = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
    const { data, error } = await supabase
      .from("ingestion_runs")
      .select(
        "id, job_name, source_name, status, rows_in, rows_out, started_at, completed_at, duration_ms, errors, warnings, report",
      )
      .gte("started_at", sinceIso)
      .order("started_at", { ascending: false })
      .limit(1000);
    if (error) {
      const msg = error.message || "";
      if (/permission|denied|rls|policy/i.test(msg)) {
        setPermissionDenied(true);
      } else {
        setError(msg);
      }
      setRows([]);
    } else {
      setRows((data ?? []) as IngestionRun[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  if (permissionDenied) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Dati raccolti per notte</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>Permessi insufficienti su ingestion_runs.</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const daily = aggregateByDay(rows);
  const lastNight = daily[0];
  const lastNightRuns = lastNight
    ? rows.filter((r) => dayKeyFmt.format(new Date(r.started_at)) === lastNight.dayKey)
    : [];
  lastNightRuns.sort(
    (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
  );

  const zeroButCompleted =
    lastNight &&
    lastNight.rowsOut === 0 &&
    lastNightRuns.some((r) => {
      const s = (r.status ?? "").toLowerCase();
      return s === "completed" || s === "success" || s === "ok";
    });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Dati raccolti per notte</CardTitle>
          <CardDescription>
            Aggregato giornaliero degli ultimi 14 giorni da <code className="text-xs">ingestion_runs</code>
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

          {lastNight && (
            <Card className="bg-muted/40">
              <CardContent className="pt-6">
                <div className="text-xs uppercase text-muted-foreground mb-1">
                  Ultima notte · {lastNight.dayLabel}
                </div>
                <div className="text-3xl font-bold">
                  {numFmt.format(lastNight.rowsOut)}{" "}
                  <span className="text-sm font-normal text-muted-foreground">record raccolti</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {lastNight.totalRuns} run totali
                  {lastNight.problemRuns > 0 && ` · ${lastNight.problemRuns} con problemi`}
                </div>
              </CardContent>
            </Card>
          )}

          {zeroButCompleted && (
            <Alert className="border-orange-500/50 text-orange-700 dark:text-orange-400 [&>svg]:text-orange-500">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Nessun nuovo record</AlertTitle>
              <AlertDescription>
                Il cron è partito ma non ha raccolto nuovi record l'ultima notte. Possibile fonte
                dati ferma o nessun nuovo dato disponibile.
              </AlertDescription>
            </Alert>
          )}

          <div className="w-full overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead className="text-right">Record raccolti</TableHead>
                  <TableHead className="text-right">Run totali</TableHead>
                  <TableHead className="text-right">Run con problemi</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {daily.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      Nessun dato negli ultimi 14 giorni.
                    </TableCell>
                  </TableRow>
                )}
                {daily.map((d) => (
                  <TableRow key={d.dayKey}>
                    <TableCell className="whitespace-nowrap">{d.dayLabel}</TableCell>
                    <TableCell className="text-right font-bold">{numFmt.format(d.rowsOut)}</TableCell>
                    <TableCell className="text-right">{numFmt.format(d.totalRuns)}</TableCell>
                    <TableCell className="text-right">
                      {d.problemRuns > 0 ? (
                        <span className="text-orange-600 font-medium">
                          {numFmt.format(d.problemRuns)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {lastNight && (
        <Card>
          <CardHeader>
            <CardTitle>Dettaglio ultima notte per fonte</CardTitle>
            <CardDescription>{lastNight.dayLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="w-full overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Orario</TableHead>
                    <TableHead>Job</TableHead>
                    <TableHead>Fonte</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Record</TableHead>
                    <TableHead className="text-right">Durata</TableHead>
                    <TableHead>Errori</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lastNightRuns.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">
                        Nessuna run.
                      </TableCell>
                    </TableRow>
                  )}
                  {lastNightRuns.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap">
                        {timeFmt.format(new Date(r.started_at))}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs font-mono">
                        {r.job_name ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {r.source_name ?? "—"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        {r.rows_out != null ? numFmt.format(r.rows_out) : "—"}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {formatDuration(r.duration_ms)}
                      </TableCell>
                      <TableCell>
                        <ErrorsCell errors={r.errors} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
