import { useMemo, useState } from "react";
import {
  SINTESI_PROPRIETARIO,
  SINTESI_ULTIMO_AGGIORNAMENTO,
  STATO_SINTESI_LABEL,
  type SintesiProprietario,
} from "@/data/civiko-one-sintesi-proprietario";
import { CLUSTER_LABEL, type ClusterCommerciale } from "@/data/civiko-one-territori";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { FileText, Flame, Target, BookOpen, MapPin, Home, ListChecks, ShieldCheck } from "lucide-react";

type FilterKey =
  | "tutti"
  | "pronte"
  | "da_completare"
  | "priorita_alta"
  | "calde";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "tutti", label: "Tutte" },
  { key: "pronte", label: "Pronte" },
  { key: "da_completare", label: "Da completare" },
  { key: "priorita_alta", label: "Priorità alta" },
  { key: "calde", label: "Opportunità calde" },
];

function tempBadgeVariant(t: SintesiProprietario["temperatura"]) {
  if (t === "caldo") return "default" as const;
  if (t === "tiepido") return "secondary" as const;
  return "outline" as const;
}

function priorityBadgeVariant(p: SintesiProprietario["priorita"]) {
  if (p === "alta") return "default" as const;
  if (p === "media") return "secondary" as const;
  return "outline" as const;
}

function statoBadgeVariant(s: SintesiProprietario["statoSintesi"]) {
  if (s === "pronta") return "default" as const;
  return "secondary" as const;
}

export default function SintesiProprietarioPage() {
  const [filter, setFilter] = useState<FilterKey>("tutti");
  const [microzona, setMicrozona] = useState<string>("tutte");
  const [cluster, setCluster] = useState<ClusterCommerciale | "tutti">("tutti");
  const [query, setQuery] = useState("");

  const microzoneOptions = useMemo(
    () => Array.from(new Set(SINTESI_PROPRIETARIO.map((s) => s.microzona))).sort(),
    [],
  );
  const clusterOptions = useMemo(
    () => Array.from(new Set(SINTESI_PROPRIETARIO.map((s) => {
      // reverse lookup cluster from label is not needed; we use label display only
      // but for value we need the key. Let's derive from SINTESI entries.
      // Actually we need the raw cluster keys. Since they're not stored in SintesiProprietario,
      // let's map via dossier. Simpler: use the list from TERRITORI clusters or just use label.
      // We need cluster keys for the select. Let's fetch from DOSSIER via ID, but avoid import.
      // Workaround: the clusterLabel is stored, and we need the key only for filtering.
      // We'll reverse-map from CLUSTER_LABEL below. For options we need unique keys.
      return s.clusterLabel;
    }))),
    [],
  );

  // We need cluster keys for the select values. Build a map from label->key.
  const clusterKeyByLabel = useMemo(() => {
    const map: Record<string, ClusterCommerciale> = {};
    for (const [key, label] of Object.entries(CLUSTER_LABEL)) {
      map[label] = key as ClusterCommerciale;
    }
    return map;
  }, []);

  const filtered = useMemo(() => {
    return SINTESI_PROPRIETARIO.filter((s) => {
      if (filter === "pronte" && s.statoSintesi !== "pronta") return false;
      if (filter === "da_completare" && s.statoSintesi !== "da_completare") return false;
      if (filter === "priorita_alta" && s.priorita !== "alta") return false;
      if (filter === "calde" && s.temperatura !== "caldo") return false;
      if (microzona !== "tutte" && s.microzona !== microzona) return false;
      if (cluster !== "tutti" && s.clusterLabel !== CLUSTER_LABEL[cluster]) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !s.titolo.toLowerCase().includes(q) &&
          !s.microzona.toLowerCase().includes(q) &&
          !s.comune.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [filter, microzona, cluster, query]);

  const summary = useMemo(() => {
    return {
      totali: SINTESI_PROPRIETARIO.length,
      pronte: SINTESI_PROPRIETARIO.filter((s) => s.statoSintesi === "pronta").length,
      prioritaAlta: SINTESI_PROPRIETARIO.filter((s) => s.priorita === "alta").length,
      calde: SINTESI_PROPRIETARIO.filter((s) => s.temperatura === "caldo").length,
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BookOpen className="h-6 w-6" />
          Sintesi Proprietario
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Versione prudente e presentabile del Dossier Agenzia, da usare durante la prima visita.
        </p>
      </div>

      {/* Sintesi */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <SummaryCard label="Sintesi totali" value={summary.totali} icon={<FileText className="h-4 w-4" />} />
        <SummaryCard label="Sintesi pronte" value={summary.pronte} icon={<ShieldCheck className="h-4 w-4" />} />
        <SummaryCard label="Priorità alta" value={summary.prioritaAlta} icon={<Target className="h-4 w-4" />} />
        <SummaryCard label="Opportunità calde" value={summary.calde} icon={<Flame className="h-4 w-4" />} />
      </div>
      <p className="text-xs text-muted-foreground">
        Ultimo aggiornamento: {SINTESI_ULTIMO_AGGIORNAMENTO}
      </p>

      {/* Nota interna */}
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">Nota interna</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          La Sintesi Proprietario è una versione prudente e presentabile del Dossier Agenzia.
          Non include fonti, score, segnali interni o dati sensibili.
          Serve a supportare una conversazione professionale e non invasiva.
        </CardContent>
      </Card>

      {/* Filtri */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filtri</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
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
          <div className="grid gap-3 md:grid-cols-3">
            <select
              value={microzona}
              onChange={(e) => setMicrozona(e.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="tutte">Tutte le microzone</option>
              {microzoneOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select
              value={cluster !== "tutti" ? CLUSTER_LABEL[cluster] : "tutti"}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "tutti") {
                  setCluster("tutti");
                } else {
                  const key = clusterKeyByLabel[val];
                  if (key) setCluster(key);
                }
              }}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="tutti">Tutti i cluster</option>
              {clusterOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cerca per titolo, microzona o comune"
            />
          </div>
        </CardContent>
      </Card>

      {/* Lista sintesi */}
      <div className="space-y-4">
        {filtered.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Nessuna sintesi corrisponde ai filtri selezionati.
            </CardContent>
          </Card>
        )}
        {filtered.map((s) => (
          <SintesiCard key={s.id} s={s} />
        ))}
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="text-2xl font-bold mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}

function SintesiCard({ s }: { s: SintesiProprietario }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-lg">{s.titolo}</CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-2 mt-1">
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {s.microzona} · {s.comune}
              </span>
              <span>·</span>
              <span>{s.clusterLabel}</span>
              <span>·</span>
              <span className="capitalize">{s.tipologiaImmobile}</span>
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={tempBadgeVariant(s.temperatura)}>
              {s.temperatura === "caldo" ? "Opportunità calda" : s.temperatura === "tiepido" ? "Opportunità tiepida" : "Opportunità da osservare"}
            </Badge>
            <Badge variant={priorityBadgeVariant(s.priorita)}>
              Priorità {s.priorita}
            </Badge>
            <Badge variant={statoBadgeVariant(s.statoSintesi)}>
              {STATO_SINTESI_LABEL[s.statoSintesi]}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Accordion type="multiple" className="w-full">
          <AccordionItem value="introduzione">
            <AccordionTrigger>
              <span className="flex items-center gap-2">
                <BookOpen className="h-4 w-4" />
                A. Introduzione
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm">
              <p className="text-sm leading-relaxed">{s.introduzione.testo}</p>
              <p className="text-sm text-muted-foreground leading-relaxed">{s.introduzione.sottotitolo}</p>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="zona">
            <AccordionTrigger>
              <span className="flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                B. Lettura della zona
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm">
              <Field label="Sentiment della zona" value={s.zona.sentiment} />
              <Field label="Domanda stimata" value={s.zona.domandaStimata} />
              <Field label="Tipologie più richieste" value={s.zona.tipologieRichieste} />
              <Field label="Andamento commerciale" value={s.zona.andamentoCommerciale} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="posizionamento">
            <AccordionTrigger>
              <span className="flex items-center gap-2">
                <Home className="h-4 w-4" />
                C. Posizionamento dell'immobile
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm">
              <Field label="Range prudente" value={s.posizionamento.rangePrudente} />
              <Field label="Range realistico" value={s.posizionamento.rangeRealistico} />
              <Field label="Range ambizioso" value={s.posizionamento.rangeAmbizioso} />
              <Field label="Spiegazione" value={s.posizionamento.spiegazione} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="valorizzazione">
            <AccordionTrigger>
              <span className="flex items-center gap-2">
                <ListChecks className="h-4 w-4" />
                D. Strategia di valorizzazione
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm">
              <Field label="Come presentare l'immobile" value={s.valorizzazione.comePresentare} />
              <ListField label="Elementi da valorizzare" items={s.valorizzazione.elementiDaValorizzare} />
              <Field label="Come evitare la sovrastima" value={s.valorizzazione.comeEvitareSovrastima} />
              <Field label="Perché partire con metodo" value={s.valorizzazione.percheMetodo} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="prossimi-passi">
            <AccordionTrigger>
              <span className="flex items-center gap-2">
                <ListChecks className="h-4 w-4" />
                E. Prossimi passi
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm">
              <Field label="Verifica diretta" value={s.prossimiPassi.verificaDiretta} />
              <Field label="Raccolta informazioni" value={s.prossimiPassi.raccoltaInformazioni} />
              <Field label="Definizione prezzo" value={s.prossimiPassi.definizionePrezzo} />
              <Field label="Piano di vendita" value={s.prossimiPassi.pianoVendita} />
              <Field label="Eventuale proposta di incarico" value={s.prossimiPassi.eventualeIncarico} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="disclaimer">
            <AccordionTrigger>
              <span className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" />
                F. Disclaimer
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="rounded-md border bg-muted/40 p-3 text-sm italic">
                {s.disclaimer.testo}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function ListField({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <ul className="list-disc pl-5 text-sm space-y-1 mt-1">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
