import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Loader2 } from "lucide-react";

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

export default function DerivedSignalsSection() {
  const [stats, setStats] = useState<Stat[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const results = await Promise.all(TABLES.map(fetchStat));
    setStats(results);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
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
