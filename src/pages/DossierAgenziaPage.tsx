import { useMemo, useState } from "react";
import {
  DOSSIER_AGENZIA,
  DOSSIER_ULTIMO_AGGIORNAMENTO,
  STATO_DOSSIER_LABEL,
  TEMPERATURA_LABEL,
  type DossierAgenzia,
} from "@/data/civiko-one-dossier-agenzia";
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
import { Briefcase, Flame, Target, Clock, MapPin, Phone, Home, FileText } from "lucide-react";

type FilterKey =
  | "tutti"
  | "pronti"
  | "in_preparazione"
  | "priorita_alta"
  | "calde";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "tutti", label: "Tutti" },
  { key: "pronti", label: "Dossier pronti" },
  { key: "in_preparazione", label: "In preparazione" },
  { key: "priorita_alta", label: "Priorità alta" },
  { key: "calde", label: "Opportunità calde" },
];

const fmtEur = (n: number) => `€ ${n.toLocaleString("it-IT")}`;
const fmtRange = (r: [number, number]) => `${fmtEur(r[0])} – ${fmtEur(r[1])}`;

function tempBadgeVariant(t: DossierAgenzia["temperatura"]) {
  if (t === "caldo") return "default" as const;
  if (t === "tiepido") return "secondary" as const;
  return "outline" as const;
}

function priorityBadgeVariant(p: DossierAgenzia["priorita"]) {
  if (p === "alta") return "default" as const;
  if (p === "media") return "secondary" as const;
  return "outline" as const;
}

function statoBadgeVariant(s: DossierAgenzia["statoDossier"]) {
  if (s === "pronto") return "default" as const;
  if (s === "in_preparazione") return "secondary" as const;
  return "outline" as const;
}

export default function DossierAgenziaPage() {
  const [filter, setFilter] = useState<FilterKey>("tutti");
  const [microzona, setMicrozona] = useState<string>("tutte");
  const [cluster, setCluster] = useState<ClusterCommerciale | "tutti">("tutti");
  const [query, setQuery] = useState("");

  const microzoneOptions = useMemo(
    () => Array.from(new Set(DOSSIER_AGENZIA.map((d) => d.microzona))).sort(),
    [],
  );
  const clusterOptions = useMemo(
    () => Array.from(new Set(DOSSIER_AGENZIA.map((d) => d.cluster))),
    [],
  );

  const filtered = useMemo(() => {
    return DOSSIER_AGENZIA.filter((d) => {
      if (filter === "pronti" && d.statoDossier !== "pronto") return false;
      if (filter === "in_preparazione" && d.statoDossier !== "in_preparazione") return false;
      if (filter === "priorita_alta" && d.priorita !== "alta") return false;
      if (filter === "calde" && d.temperatura !== "caldo") return false;
      if (microzona !== "tutte" && d.microzona !== microzona) return false;
      if (cluster !== "tutti" && d.cluster !== cluster) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !d.titoloOpportunita.toLowerCase().includes(q) &&
          !d.microzona.toLowerCase().includes(q) &&
          !d.comune.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [filter, microzona, cluster, query]);

  const summary = useMemo(() => {
    return {
      totali: DOSSIER_AGENZIA.length,
      pronti: DOSSIER_AGENZIA.filter((d) => d.statoDossier === "pronto").length,
      prioritaAlta: DOSSIER_AGENZIA.filter((d) => d.priorita === "alta").length,
      calde: DOSSIER_AGENZIA.filter((d) => d.temperatura === "caldo").length,
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Briefcase className="h-6 w-6" />
          Dossier Agenzia
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Schede operative collegate alle Opportunità Pilota di Metodo Civiko One.
        </p>
      </div>

      {/* Sintesi */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <SummaryCard label="Dossier totali" value={summary.totali} icon={<Briefcase className="h-4 w-4" />} />
        <SummaryCard label="Dossier pronti" value={summary.pronti} icon={<FileText className="h-4 w-4" />} />
        <SummaryCard label="Priorità alta" value={summary.prioritaAlta} icon={<Target className="h-4 w-4" />} />
        <SummaryCard label="Opportunità calde" value={summary.calde} icon={<Flame className="h-4 w-4" />} />
      </div>
      <p className="text-xs text-muted-foreground">
        Ultimo aggiornamento: {DOSSIER_ULTIMO_AGGIORNAMENTO}
      </p>

      {/* Nota interna */}
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">Nota interna</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Il Dossier Agenzia serve a preparare l'agente alla telefonata e alla prima visita.
          Le informazioni sono operative e commerciali. Le fonti, gli score interni e i segnali
          sensibili restano nel Central Core.
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
              value={cluster}
              onChange={(e) => setCluster(e.target.value as ClusterCommerciale | "tutti")}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="tutti">Tutti i cluster</option>
              {clusterOptions.map((c) => (
                <option key={c} value={c}>
                  {CLUSTER_LABEL[c]}
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

      {/* Lista dossier */}
      <div className="space-y-4">
        {filtered.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Nessun dossier corrisponde ai filtri selezionati.
            </CardContent>
          </Card>
        )}
        {filtered.map((d) => (
          <DossierCard key={d.id} d={d} />
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

function DossierCard({ d }: { d: DossierAgenzia }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-lg">{d.titoloOpportunita}</CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-2 mt-1">
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {d.microzona} · {d.comune}
              </span>
              <span>·</span>
              <span>{d.clusterLabel}</span>
              <span>·</span>
              <span className="capitalize">{d.tipologiaImmobile}</span>
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={tempBadgeVariant(d.temperatura)}>
              {TEMPERATURA_LABEL[d.temperatura]}
            </Badge>
            <Badge variant={priorityBadgeVariant(d.priorita)}>
              Priorità {d.priorita}
            </Badge>
            <Badge variant={statoBadgeVariant(d.statoDossier)}>
              {STATO_DOSSIER_LABEL[d.statoDossier]}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Riepilogo numerico */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Stat label="Probabilità incarico" value={`${d.probabilitaIncaricoStimata}%`} />
          <Stat label="Valore stimato" value={fmtEur(d.valoreStimatoEur)} />
          <Stat label="Potenziale provvigionale" value={fmtEur(d.potenzialeProvvigionaleEur)} />
          <Stat
            label="Timing consigliato"
            value={d.timingConsigliato}
            icon={<Clock className="h-3 w-3" />}
          />
        </div>

        <Accordion type="multiple" className="w-full">
          <AccordionItem value="sintesi">
            <AccordionTrigger>A. Sintesi opportunità</AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm">
              <Field label="Perché è interessante" value={d.sintesi.perchePotenziale} />
              <Field label="Perché agire adesso" value={d.sintesi.perchAgireAdesso} />
              <Field label="Urgenza commerciale" value={d.sintesi.urgenza} />
              <Field label="Obiettivo dell'agente" value={d.sintesi.obiettivoAgente} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="zona">
            <AccordionTrigger>B. Lettura zona</AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm">
              <Field label="Sentiment" value={d.zona.sentiment} />
              <Field label="Domanda / Offerta" value={d.zona.domandaOfferta} />
              <Field label="Tipologie più richieste" value={d.zona.tipologieRichieste} />
              <Field label="Fascia percepita" value={d.zona.fasciaPercepita} />
              <Field label="Note commerciali" value={d.zona.noteCommerciali} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="posizionamento">
            <AccordionTrigger>
              <span className="flex items-center gap-2">
                <Home className="h-4 w-4" />
                C. Posizionamento immobile
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm">
              <Field label="Range prudente" value={fmtRange(d.posizionamento.rangePrudenteEur)} />
              <Field label="Range realistico" value={fmtRange(d.posizionamento.rangeRealisticoEur)} />
              <Field label="Range ambizioso" value={fmtRange(d.posizionamento.rangeAmbiziosoEur)} />
              <Field
                label="Potenziale valorizzazione"
                value={d.posizionamento.potenzialeValorizzazione}
              />
              <Field label="Rischio sovrastima" value={d.posizionamento.rischioSovrastima} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="telefonata">
            <AccordionTrigger>
              <span className="flex items-center gap-2">
                <Phone className="h-4 w-4" />
                D. Strategia telefonata
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm">
              <Field label="Obiettivo chiamata" value={d.telefonata.obiettivo} />
              <Field label="Frase di apertura" value={d.telefonata.apertura} />
              <ListField label="Domande consentite" items={d.telefonata.domandeConsentite as unknown as string[]} />
              <ListField label="Cosa evitare" items={d.telefonata.cosaEvitare} />
              <Field label="Come proporre l'appuntamento" value={d.telefonata.comeProporreAppuntamento} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="visita">
            <AccordionTrigger>E. Strategia prima visita</AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm">
              <Field label="Come presentarsi" value={d.visita.comePresentarsi} />
              <Field label="Come introdurre il metodo" value={d.visita.comeIntrodurreMetodo} />
              <ListField label="Argomenti forti" items={d.visita.argomentiForti} />
              <ListField label="Obiezioni probabili" items={d.visita.obiezioniProbabili} />
              <ListField label="Risposte consigliate" items={d.visita.rispostaObiezioni} />
              <Field label="Verso la proposta di esclusiva" value={d.visita.versoEsclusiva} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="script">
            <AccordionTrigger>F. Script sicuro per il proprietario</AccordionTrigger>
            <AccordionContent>
              <div className="rounded-md border bg-muted/40 p-3 text-sm italic">
                {d.script.testo}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Testo non invasivo: parla di analisi di zona, posizionamento e strategia commerciale.
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className="font-semibold">{value}</div>
    </div>
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
