import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Loader2 } from "lucide-react";

type SourceRow = {
  source_code: string;
  source_name: string | null;
  automation_status: string | null;
  last_run_at: string | null;
  record_count: number | null;
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

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return dtFmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

export default function IngestionRunsSection() {
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
      .select("source_code, source_name, automation_status, last_run_at, record_count")
      .limit(500);
    if (error) {
      const msg = error.message || "";
      if (/permission|denied|rls|policy/i.test(msg)) {
        setPermissionDenied(true);
      } else {
        setError(msg);
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
          <CardTitle>Raccolta ultima esecuzione</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>Permessi insufficienti su civiko_source_registry.</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const withRun = rows.filter((r) => r.last_run_at != null);
  const totalRecords = withRun.reduce((s, r) => s + (r.record_count ?? 0), 0);
  const lastRunIso = withRun.reduce<string | null>((max, r) => {
    if (!r.last_run_at) return max;
    if (!max || r.last_run_at > max) return r.last_run_at;
    return max;
  }, null);

  const collected = withRun
    .filter((r) => (r.record_count ?? 0) > 0)
    .sort((a, b) => (b.record_count ?? 0) - (a.record_count ?? 0));

  const now = Date.now();
  const recentAutomatedRan = rows.some((r) => {
    const s = (r.automation_status ?? "").toLowerCase();
    const isAutomated = s === "enabled" || s === "active" || s === "scheduled" || s === "automated";
    if (!isAutomated || !r.last_run_at) return false;
    return now - new Date(r.last_run_at).getTime() <= 26 * 3600_000;
  });
  const zeroButRan = totalRecords === 0 && recentAutomatedRan;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Raccolta ultima esecuzione</CardTitle>
        <CardDescription>
          Record raccolti da ciascuna fonte nell'ultima esecuzione automatica
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

        <Card className="bg-muted/40">
          <CardContent className="pt-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="text-xs uppercase text-muted-foreground mb-1">
                  Totale record ultima raccolta
                </div>
                <div className="text-3xl font-bold">{numFmt.format(totalRecords)}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground mb-1">
                  Ultima esecuzione più recente
                </div>
                <div className="text-lg font-medium">{formatDate(lastRunIso)}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {zeroButRan && (
          <Alert className="border-orange-500/50 text-orange-700 dark:text-orange-400 [&>svg]:text-orange-500">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Nessun record raccolto</AlertTitle>
            <AlertDescription>
              Le fonti automatiche sono partite ma non hanno raccolto record nell'ultima esecuzione.
            </AlertDescription>
          </Alert>
        )}

        <div className="w-full overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Codice</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead className="text-right">Record raccolti</TableHead>
                <TableHead>Ultima esecuzione</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {collected.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    Nessuna fonte ha raccolto record nell'ultima esecuzione.
                  </TableCell>
                </TableRow>
              )}
              {collected.map((r) => (
                <TableRow key={r.source_code}>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {r.source_code}
                  </TableCell>
                  <TableCell className="text-sm">{r.source_name ?? "—"}</TableCell>
                  <TableCell className="text-right font-bold">
                    {numFmt.format(r.record_count ?? 0)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {formatDate(r.last_run_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
          <code className="text-xs">record_count</code> riflette l'ultima esecuzione di ogni fonte,
          non uno storico cumulativo. Non è disponibile uno storico giorno-per-giorno: il registro
          conserva solo l'ultimo valore per fonte.
        </div>
      </CardContent>
    </Card>
  );
}
