import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  OPPORTUNITA_PILOTA,
  ULTIMO_AGGIORNAMENTO_OPPORTUNITA,
  STATO_DOSSIER_LABEL,
  STATO_DATO_LABEL,
  TIMING_LABEL,
  toPublicOpportunita,
  type Temperatura,
  type Priorita,
  type StatoDossier,
} from "@/data/civiko-one-opportunita-pilota";
import { CLUSTER_LABEL, TERRITORI_CIVIKO_ONE } from "@/data/civiko-one-territori";
import { Flame, ThermometerSun, Snowflake, Search, Info, ShieldCheck } from "lucide-react";
import { DemoDataBanner } from "@/components/DemoDataBanner";

type Filtro =
  | "tutte"
  | "calde"
  | "tiepide"
  | "fredde"
  | "priorita_alta"
  | "dossier_pronti"
  | "da_verificare";

const FILTRI: { id: Filtro; label: string }[] = [
  { id: "tutte", label: "Tutte" },
  { id: "calde", label: "Calde" },
  { id: "tiepide", label: "Tiepide" },
  { id: "fredde", label: "Fredde" },
  { id: "priorita_alta", label: "Priorità alta" },
  { id: "dossier_pronti", label: "Dossier pronti" },
  { id: "da_verificare", label: "Da verificare" },
];

const tempIcon = (t: Temperatura) =>
  t === "caldo" ? <Flame className="h-3 w-3" /> : t === "tiepido" ? <ThermometerSun className="h-3 w-3" /> : <Snowflake className="h-3 w-3" />;

const tempVariant = (t: Temperatura) =>
  t === "caldo" ? "default" : t === "tiepido" ? "secondary" : "outline";

const prioVariant = (p: Priorita) =>
  p === "alta" ? "default" : p === "media" ? "secondary" : "outline";

const dossierVariant = (s: StatoDossier) =>
  s === "pronto" ? "default" : s === "in_preparazione" ? "secondary" : "outline";

const fmtEur = (n: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);

export default function OpportunitaPilotaPage() {
  const [filtro, setFiltro] = useState<Filtro>("tutte");
  const [microzona, setMicrozona] = useState<string>("__all__");
  const [cluster, setCluster] = useState<string>("__all__");
  const [query, setQuery] = useState("");

  // Esponiamo solo la proiezione pubblica: i campi interni Core non escono mai dalla pagina.
  const opportunita = useMemo(() => OPPORTUNITA_PILOTA.map(toPublicOpportunita), []);

  const microzoneDisponibili = useMemo(
    () => Array.from(new Set(opportunita.map((o) => o.microzona))).sort(),
    [opportunita],
  );

  const filtrate = useMemo(() => {
    return opportunita.filter((o) => {
      if (filtro === "calde" && o.temperatura !== "caldo") return false;
      if (filtro === "tiepide" && o.temperatura !== "tiepido") return false;
      if (filtro === "fredde" && o.temperatura !== "freddo") return false;
      if (filtro === "priorita_alta" && o.priorita !== "alta") return false;
      if (filtro === "dossier_pronti" && o.statoDossier !== "pronto") return false;
      if (filtro === "da_verificare" && o.statoDato !== "da_verificare" && o.statoDossier !== "da_verificare") return false;
      if (microzona !== "__all__" && o.microzona !== microzona) return false;
      if (cluster !== "__all__" && o.cluster !== cluster) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !o.titoloCommerciale.toLowerCase().includes(q) &&
          !o.microzona.toLowerCase().includes(q) &&
          !o.comune.toLowerCase().includes(q)
        ) return false;
      }
      return true;
    });
  }, [opportunita, filtro, microzona, cluster, query]);

  const totali = opportunita.length;
  const calde = opportunita.filter((o) => o.temperatura === "caldo").length;
  const prioAlta = opportunita.filter((o) => o.priorita === "alta").length;
  const dossierPronti = opportunita.filter((o) => o.statoDossier === "pronto").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          Opportunità Pilota
          <Badge variant="outline">Anteprima esempio</Badge>
        </h1>
        <p className="text-sm text-muted-foreground">
          Base operativa Metodo Civiko One — territorio pilota dimostrativo: {TERRITORI_CIVIKO_ONE[0].nome}.
        </p>
      </div>

      <DemoDataBanner />


      {/* Sintesi */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <SummaryCard label="Opportunità totali" value={String(totali)} />
        <SummaryCard label="Opportunità calde" value={String(calde)} />
        <SummaryCard label="Priorità alta" value={String(prioAlta)} />
        <SummaryCard label="Dossier pronti" value={String(dossierPronti)} />
        <SummaryCard label="Ultimo aggiornamento" value={ULTIMO_AGGIORNAMENTO_OPPORTUNITA} />
      </div>

      {/* Nota interna */}
      <Card className="border-dashed">
        <CardHeader className="flex-row items-start gap-3 space-y-0">
          <ShieldCheck className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <CardTitle className="text-base">Nota interna Core</CardTitle>
            <CardDescription className="mt-1">
              Le opportunità pilota sono generate come base operativa per Metodo Civiko One.
              Le fonti e i segnali interni restano nel Central Core. La PWA riceve solo
              informazioni commerciali pulite e non invasive.
            </CardDescription>
          </div>
        </CardHeader>
      </Card>

      {/* Filtri */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filtri</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {FILTRI.map((f) => (
              <Button
                key={f.id}
                variant={filtro === f.id ? "default" : "outline"}
                size="sm"
                onClick={() => setFiltro(f.id)}
              >
                {f.label}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Cerca per titolo, microzona, comune…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
              />
            </div>
            <Select value={microzona} onValueChange={setMicrozona}>
              <SelectTrigger>
                <SelectValue placeholder="Microzona" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Tutte le microzone</SelectItem>
                {microzoneDisponibili.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={cluster} onValueChange={setCluster}>
              <SelectTrigger>
                <SelectValue placeholder="Cluster" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Tutti i cluster</SelectItem>
                {Object.entries(CLUSTER_LABEL).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Lista opportunità */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {filtrate.map((o) => (
          <Card key={o.id}>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="text-base leading-snug">{o.titoloCommerciale}</CardTitle>
                  <CardDescription className="mt-1">
                    {o.microzona} · {o.comune} · {CLUSTER_LABEL[o.cluster]}
                  </CardDescription>
                </div>
                <Badge variant={tempVariant(o.temperatura)} className="gap-1 capitalize shrink-0">
                  {tempIcon(o.temperatura)} {o.temperatura}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant={prioVariant(o.priorita)} className="capitalize">Priorità {o.priorita}</Badge>
                <Badge variant={dossierVariant(o.statoDossier)}>{STATO_DOSSIER_LABEL[o.statoDossier]}</Badge>
                <Badge variant="outline">{TIMING_LABEL[o.timingConsigliato]}</Badge>
                <Badge variant="outline" className="capitalize">{o.tipologiaImmobile.replace("_", " ")}</Badge>
                <Badge variant="secondary">{STATO_DATO_LABEL[o.statoDato]}</Badge>
              </div>

              <div className="grid grid-cols-3 gap-3 text-sm">
                <KV label="Probabilità" value={`${o.probabilitaIncaricoStimata}%`} />
                <KV label="Valore stimato" value={fmtEur(o.valoreStimatoEur)} />
                <KV label="Provvigione" value={fmtEur(o.potenzialeProvvigionaleEur)} />
              </div>

              <div className="text-sm space-y-1">
                <p><span className="text-muted-foreground">Finestra:</span> {o.finestraUtile}</p>
                <p><span className="text-muted-foreground">Motivo:</span> {o.motivoCommerciale}</p>
                <p><span className="text-muted-foreground">Prossima azione:</span> {o.prossimaAzione}</p>
              </div>

              <p className="text-xs text-muted-foreground font-mono">{o.id}</p>
            </CardContent>
          </Card>
        ))}
        {filtrate.length === 0 && (
          <Card className="lg:col-span-2">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              <Info className="h-5 w-5 mx-auto mb-2" />
              Nessuna opportunità corrisponde ai filtri selezionati.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold mt-1">{value}</p>
      </CardContent>
    </Card>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
