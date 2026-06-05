import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2, PlayCircle, CheckCircle2, XCircle } from "lucide-react";

type TableSpec = {
  table: string;
  label: string;
  dateField: string;
};

const TABLES: TableSpec[] = [
  { table: "urgent_opportunity_signals", label: "Opportunità urgenti", dateField: "created_at" },
  { table: "motivated_sellers", label: "Venditori motivati", dateField: "detected_at" },
  { table: "radar_signals", label: "Segnali radar", dateField: "detected_at" },
  { table: "territorial_signals", label: "Segnali territoriali", dateField: "detected_at" },
  { table: "inheritance_pressure_signals", label: "Pressione successioni", dateField: "computed_at" },
  { table: "estate_turnover_zones", label: "Zone turnover patrimoni", dateField: "computed_at" },
];

type Stat = {
  spec: TableSpec;
  count: number | null;
  lastAt: string | null;
  error: boolean;
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

async function fetchStat(spec: TableSpec): Promise<Stat> {
  try {
    const countRes = await (supabase as any)
      .from(spec.table)
      .select("id", { count: "exact", head: true })
      .eq("is_active", true);
    if (countRes.error) return { spec, count: null, lastAt: null, error: true };
    const count = countRes.count ?? 0;

    let lastAt: string | null = null;
    if (count > 0) {
      const lastRes = await (supabase as any)
        .from(spec.table)
        .select(spec.dateField)
        .eq("is_active", true)
        .order(spec.dateField, { ascending: false })
        .limit(1);
      if (!lastRes.error && lastRes.data && lastRes.data[0]) {
        lastAt = lastRes.data[0][spec.dateField] ?? null;
      }
    }
    return { spec, count, lastAt, error: false };
  } catch {
    return { spec, count: null, lastAt: null, error: true };
  }
}

type ChainResult = {
  ok: boolean;
  started?: boolean;
  invoked_by?: string;
  message?: string;
  jobs?: string[];
  error?: string;
};

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY) as string;

export default function DerivedSignalsSection() {
  const [stats, setStats] = useState<Stat[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [chainResult, setChainResult] = useState<ChainResult | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const results = await Promise.all(TABLES.map(fetchStat));
    setStats(results);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const runChain = useCallback(async () => {
    setRunning(true);
    setChainResult(null);
    setChainError(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setChainError("Sessione scaduta, rifai login.");
        setRunning(false);
        return;
      }
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/run-offmarket-chain-admin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON,
        },
        body: JSON.stringify({}),
      });
      const txt = await resp.text();
      let body: ChainResult | null = null;
      try { body = JSON.parse(txt); } catch { /* ignore */ }
      if (resp.status === 401) {
        setChainError("Sessione scaduta, rifai login.");
      } else if (resp.status === 403) {
        setChainError("Accesso riservato agli admin.");
      } else if (!resp.ok) {
        setChainError(body?.error || `Errore HTTP ${resp.status}`);
      } else {
        setChainResult(body);
      }
    } catch (e) {
      setChainError(e instanceof Error ? e.message : "Errore di rete");
    } finally {
      setRunning(false);
      await fetchAll();
    }
  }, [fetchAll]);


  const total = stats.reduce((s, x) => s + (x.count ?? 0), 0);
  const mostRecent = stats.reduce<string | null>((max, x) => {
    if (!x.lastAt) return max;
    if (!max || x.lastAt > max) return x.lastAt;
    return max;
  }, null);

  const noSignals = !loading && total === 0;
  const stale =
    !loading &&
    total > 0 &&
    mostRecent != null &&
    Date.now() - new Date(mostRecent).getTime() > 48 * 3600_000;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Segnali off-market derivati</CardTitle>
        <CardDescription>
          Segnali attivi prodotti dall'elaborazione dei dati grezzi
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
          <div className="text-sm text-muted-foreground">
            Lancia subito la catena di derivazione senza aspettare il cron notturno.
          </div>
          <Button onClick={runChain} disabled={running}>
            {running ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generazione in corso… (può richiedere alcuni minuti)
              </>
            ) : (
              <>
                <PlayCircle className="h-4 w-4 mr-2" />
                Genera off-market ora
              </>
            )}
          </Button>
        </div>

        {chainError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{chainError}</AlertDescription>
          </Alert>
        )}

        {chainResult?.steps && (
          <Card className="bg-muted/30">
            <CardContent className="pt-6 space-y-2">
              <div className="text-xs uppercase text-muted-foreground">
                Esito catena · {chainResult.invoked_by ?? "—"}
                {chainResult.total_duration_ms != null &&
                  ` · ${(chainResult.total_duration_ms / 1000).toFixed(1)}s`}
              </div>
              <ul className="space-y-1.5">
                {chainResult.steps.map((s) => (
                  <li key={s.job} className="flex items-start gap-2 text-sm">
                    {s.ok ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs">{s.job}</div>
                      <div className="text-xs text-muted-foreground break-words">
                        HTTP {s.http_status} · {(s.duration_ms / 1000).toFixed(1)}s
                        {s.error && ` · ${s.error}`}
                        {!s.ok && s.excerpt && ` · ${s.excerpt.slice(0, 200)}`}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {loading && (
          <div className="flex items-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Caricamento…
          </div>
        )}

        <Card className="bg-muted/40">
          <CardContent className="pt-6">
            <div className="text-xs uppercase text-muted-foreground mb-1">
              Totale segnali off-market attivi
            </div>
            <div className="text-3xl font-bold">{numFmt.format(total)}</div>
            {mostRecent && (
              <div className="text-xs text-muted-foreground mt-1">
                Ultimo segnale: {formatDate(mostRecent)}
              </div>
            )}
          </CardContent>
        </Card>

        {noSignals && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Nessun segnale off-market derivato</AlertTitle>
            <AlertDescription>
              I dati grezzi vengono raccolti ma l'elaborazione dei segnali non sta producendo
              risultati: verificare i job di derivazione (deriveSignals / advancedOpportunity).
            </AlertDescription>
          </Alert>
        )}

        {stale && (
          <Alert className="border-orange-500/50 text-orange-700 dark:text-orange-400 [&>svg]:text-orange-500">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Segnali non aggiornati</AlertTitle>
            <AlertDescription>
              Segnali presenti ma nessuno nuovo nelle ultime 48 ore: l'elaborazione potrebbe essersi
              fermata.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {stats.map((s) => (
            <Card key={s.spec.table}>
              <CardContent className="pt-6">
                <div className="text-xs uppercase text-muted-foreground mb-1">{s.spec.label}</div>
                {s.error ? (
                  <>
                    <div className="text-3xl font-bold text-muted-foreground">—</div>
                    <div className="text-xs text-muted-foreground mt-1">Non disponibile</div>
                  </>
                ) : (
                  <>
                    <div className="text-3xl font-bold">{numFmt.format(s.count ?? 0)}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {(s.count ?? 0) > 0
                        ? `Ultimo segnale: ${formatDate(s.lastAt)}`
                        : "Nessun segnale"}
                    </div>
                  </>
                )}
                <div className="text-[10px] font-mono text-muted-foreground mt-2 truncate">
                  {s.spec.table}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
