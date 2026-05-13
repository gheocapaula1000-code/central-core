import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  TERRITORI_CIVIKO_ONE,
  CLUSTER_LABEL,
  FASE_LABEL,
  type Microzona,
  type ClusterCommerciale,
  type StatoMicrozona,
  type FasePilota,
} from "@/data/civiko-one-territori";
import {
  getServiziProssimita,
  CATEGORIA_LABEL,
  PRESENZA_LABEL,
  type PresenzaServizio,
  type CategoriaServizio,
  type MaturitaDato,
} from "@/data/civiko-one-servizi-prossimita";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const presenzaVariant: Record<PresenzaServizio, string> = {
  forte_presenza: "bg-emerald-900/40 text-emerald-200 border-emerald-800",
  presenza_media: "bg-sky-900/40 text-sky-200 border-sky-800",
  presenza_limitata: "bg-amber-900/40 text-amber-200 border-amber-800",
  da_verificare: "bg-slate-800 text-slate-300 border-slate-700",
};

const maturitaLabel: Record<MaturitaDato, string> = {
  demo: "Demo",
  da_verificare: "Da verificare",
  verificato: "Verificato",
};

const maturitaVariant: Record<MaturitaDato, string> = {
  demo: "bg-slate-800 text-slate-300 border-slate-700",
  da_verificare: "bg-amber-900/40 text-amber-200 border-amber-800",
  verificato: "bg-emerald-900/40 text-emerald-200 border-emerald-800",
};

const CATEGORIE_ORDINE: CategoriaServizio[] = [
  "supermercati",
  "alimentari_botteghe",
  "bar",
  "ristoranti",
  "pizzerie",
  "tabacchini",
  "farmacie",
  "scuole",
  "asili",
  "fermate_bus_tram",
  "parcheggi",
  "parchi_aree_verdi",
  "studi_medici",
  "banche_sportelli",
  "poste",
  "palestre_sport",
  "servizi_famiglie",
];

function ServiziProssimitaBlock({ comune, nome }: { comune: string; nome: string }) {
  const data = getServiziProssimita(comune, nome);
  if (!data) {
    return (
      <Accordion type="single" collapsible className="w-full">
        <AccordionItem value="servizi" className="border-t border-b-0">
          <AccordionTrigger className="text-xs py-2 hover:no-underline">
            Servizi di prossimità
          </AccordionTrigger>
          <AccordionContent>
            <p className="text-xs text-muted-foreground">
              Dato non ancora censito per questa microzona.
            </p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  }
  return (
    <Accordion type="single" collapsible className="w-full">
      <AccordionItem value="servizi" className="border-t border-b-0">
        <AccordionTrigger className="text-xs py-2 hover:no-underline">
          <span className="flex items-center gap-2">
            Servizi di prossimità
            <Badge variant="outline" className={maturitaVariant[data.maturitaDato]}>
              {maturitaLabel[data.maturitaDato]}
            </Badge>
          </span>
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          <div className="grid grid-cols-1 gap-1">
            {CATEGORIE_ORDINE.map((cat) => {
              const presenza = data.categorie[cat] ?? "da_verificare";
              return (
                <div key={cat} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{CATEGORIA_LABEL[cat]}</span>
                  <Badge variant="outline" className={presenzaVariant[presenza]}>
                    {PRESENZA_LABEL[presenza]}
                  </Badge>
                </div>
              );
            })}
          </div>

          <div className="pt-2 border-t border-border space-y-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Lettura commerciale dei servizi
            </p>
            <p className="text-xs leading-relaxed">{data.letturaCommerciale}</p>
          </div>

          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Argomenti utili per l'agente
            </p>
            <ul className="text-xs leading-relaxed list-disc pl-4 space-y-0.5">
              {data.argomentiUtiliAgente.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

type FilterKey =
  | "tutti"
  | ClusterCommerciale
  | "stato_attivo"
  | "stato_da_completare"
  | "stato_futuro"
  | "fase_1";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "tutti", label: "Tutti" },
  { key: "fase_1", label: "Fase 1" },
  { key: "padova_citta", label: "Padova città" },
  { key: "prima_cintura", label: "Prima cintura" },
  { key: "termali_premium", label: "Termali / premium" },
  { key: "provincia_estendere", label: "Provincia da estendere" },
  { key: "stato_attivo", label: "Attivi" },
  { key: "stato_da_completare", label: "Da completare" },
  { key: "stato_futuro", label: "Futuri" },
];

const sentimentVariant: Record<string, string> = {
  favorevole: "bg-emerald-900/40 text-emerald-200 border-emerald-800",
  neutro: "bg-secondary text-muted-foreground",
  debole: "bg-amber-900/40 text-amber-200 border-amber-800",
  da_verificare: "bg-slate-800 text-slate-300 border-slate-700",
};

const statoVariant: Record<StatoMicrozona, string> = {
  attivo: "bg-emerald-900/40 text-emerald-200 border-emerald-800",
  da_completare: "bg-amber-900/40 text-amber-200 border-amber-800",
  futuro: "bg-slate-800 text-slate-300 border-slate-700",
};

const statoLabel: Record<StatoMicrozona, string> = {
  attivo: "Attivo",
  da_completare: "Da completare",
  futuro: "Futuro",
};

const faseVariant: Record<FasePilota, string> = {
  fase_1: "bg-sky-900/40 text-sky-200 border-sky-800",
  fase_2: "bg-secondary text-muted-foreground",
  futura: "bg-slate-800 text-slate-300 border-slate-700",
};

function fmt(value: string) {
  return value.replace(/_/g, " ");
}

function MicrozonaCard({ m }: { m: Microzona }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{m.nome}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {m.comune} · {CLUSTER_LABEL[m.cluster]}
            </p>
          </div>
          <Badge variant="outline" className={statoVariant[m.stato]}>
            {statoLabel[m.stato]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Fascia percepita</span>
          <span className="capitalize">{m.fasciaPercepita}</span>
        </div>
        <div className="flex items-start justify-between gap-2">
          <span className="text-muted-foreground">Tipologie</span>
          <span className="text-right text-xs">
            {m.tipologiePrevalenti.map(fmt).join(", ")}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Domanda / Offerta</span>
          <span className="space-x-1">
            <Badge variant="outline" className="capitalize">{fmt(m.domandaStimata)}</Badge>
            <Badge variant="outline" className="capitalize">{fmt(m.offertaStimata)}</Badge>
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Sentiment</span>
          <Badge variant="outline" className={`capitalize ${sentimentVariant[m.sentimentCommerciale] ?? ""}`}>
            {fmt(m.sentimentCommerciale)}
          </Badge>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Opportunità attive</span>
          <span className="font-mono">{m.opportunitaAttive}</span>
        </div>
        <p className="text-[10px] text-muted-foreground text-right pt-1">
          Aggiornato: {m.ultimoAggiornamento}
        </p>
        <ServiziProssimitaBlock comune={m.comune} nome={m.nome} />
      </CardContent>
    </Card>
  );
}


export default function TerritoriPage() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("tutti");
  const territorio = TERRITORI_CIVIKO_ONE[0];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return territorio.microzone.filter((m) => {
      if (filter !== "tutti") {
        if (filter === "stato_attivo" && m.stato !== "attivo") return false;
        if (filter === "stato_da_completare" && m.stato !== "da_completare") return false;
        if (filter === "stato_futuro" && m.stato !== "futuro") return false;
        if (
          filter !== "stato_attivo" &&
          filter !== "stato_da_completare" &&
          filter !== "stato_futuro" &&
          m.cluster !== filter
        ) {
          return false;
        }
      }
      if (!q) return true;
      return (
        m.nome.toLowerCase().includes(q) ||
        m.comune.toLowerCase().includes(q) ||
        CLUSTER_LABEL[m.cluster].toLowerCase().includes(q)
      );
    });
  }, [query, filter, territorio.microzone]);

  const totale = territorio.microzone.length;
  const attive = territorio.microzone.filter((m) => m.stato === "attivo").length;
  const opportunitaAttive = territorio.microzone.reduce((acc, m) => acc + m.opportunitaAttive, 0);
  const ultimoAggiornamento = territorio.microzone
    .map((m) => m.ultimoAggiornamento)
    .sort()
    .pop();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Territori</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Pilota territoriale per <span className="font-medium">Metodo Civiko One</span>.
            Dati operativi interni Core.
          </p>
        </div>
        <Badge variant="outline">PWA principale: Metodo Civiko One</Badge>
      </div>

      {/* Sintesi */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Territorio pilota</p>
            <p className="font-semibold mt-1">{territorio.nome}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Microzone censite</p>
            <p className="text-2xl font-bold mt-1">{totale}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Microzone attive</p>
            <p className="text-2xl font-bold mt-1">{attive}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Opportunità attive</p>
            <p className="text-2xl font-bold mt-1">{opportunitaAttive}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Ultimo aggiornamento</p>
            <p className="font-semibold mt-1">{ultimoAggiornamento ?? "—"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Nota interna */}
      <Card className="border-dashed">
        <CardContent className="p-4 text-xs text-muted-foreground">
          Questa sezione serve a strutturare il pilota territoriale di Metodo Civiko One.
          I dati mostrati sono operativi e possono essere aggiornati dal Central Core.
          Nessuna fonte grezza o informazione sensibile viene esposta.
        </CardContent>
      </Card>

      {/* Filtri */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex flex-wrap gap-2">
              {FILTERS.map((f) => (
                <Button
                  key={f.key}
                  variant={filter === f.key ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </Button>
              ))}
            </div>
            <Input
              placeholder="Filtra per nome, comune o cluster"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="max-w-xs"
            />
          </div>
        </CardHeader>
      </Card>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Nessuna microzona corrisponde ai filtri selezionati.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((m) => (
            <MicrozonaCard key={`${m.comune}-${m.nome}`} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}
