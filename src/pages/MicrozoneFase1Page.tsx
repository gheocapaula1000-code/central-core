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
  type FasePilota,
} from "@/data/civiko-one-territori";
import { OPPORTUNITA_PILOTA } from "@/data/civiko-one-opportunita-pilota";
import { DOSSIER_AGENZIA } from "@/data/civiko-one-dossier-agenzia";
import { getServiziProssimita } from "@/data/civiko-one-servizi-prossimita";

type PrioritaOperativa = "massima" | "alta" | "media" | "bassa";
type MaturitaDato = "demo_operativa" | "da_verificare" | "verificato";
type StatoFase = "fase_1" | "in_osservazione" | "futura";
type StatoTestReale = "test_reale_pronto" | "in_attesa" | "non_applicabile";

// Microzona unica selezionata come primo test reale del pilota.
const TEST_REALE_KEY = "Padova-Arcella";

interface RigaFase1 {
  microzona: Microzona;
  statoFase: StatoFase;
  priorita: PrioritaOperativa;
  maturita: MaturitaDato;
  attivo: boolean;
  opportunita: number;
  dossier: number;
  serviziDisponibili: boolean;
  notaInterna: string;
  prontaPerTestReali: boolean;
  isTestReale: boolean;
  statoTestReale: StatoTestReale;
}

// Mappatura stato fase derivata dal dataset territori esistente.
function deriveStato(m: Microzona): StatoFase {
  if (m.fasePilota === "fase_1") return "fase_1";
  if (m.fasePilota === "fase_2") return "in_osservazione";
  return "futura";
}

function derivePriorita(m: Microzona, opp: number): PrioritaOperativa {
  if (m.fasePilota === "fase_1" && (m.sentimentCommerciale === "favorevole" || opp >= 2)) return "alta";
  if (m.fasePilota === "fase_1") return "media";
  return "bassa";
}

function deriveMaturita(m: Microzona, opp: number, servizi: boolean): MaturitaDato {
  if (m.stato === "attivo" && opp > 0 && servizi) return "demo_operativa";
  if (m.stato === "attivo") return "da_verificare";
  return "da_verificare";
}

const statoFaseLabel: Record<StatoFase, string> = {
  fase_1: "Fase 1",
  in_osservazione: "In osservazione",
  futura: "Futura",
};

const statoFaseVariant: Record<StatoFase, string> = {
  fase_1: "bg-sky-900/40 text-sky-200 border-sky-800",
  in_osservazione: "bg-secondary text-muted-foreground",
  futura: "bg-slate-800 text-slate-300 border-slate-700",
};

const prioritaVariant: Record<PrioritaOperativa, string> = {
  massima: "bg-fuchsia-900/40 text-fuchsia-200 border-fuchsia-800",
  alta: "bg-emerald-900/40 text-emerald-200 border-emerald-800",
  media: "bg-amber-900/40 text-amber-200 border-amber-800",
  bassa: "bg-slate-800 text-slate-300 border-slate-700",
};

const statoTestRealeLabel: Record<StatoTestReale, string> = {
  test_reale_pronto: "Test reale pronto",
  in_attesa: "In attesa",
  non_applicabile: "—",
};

const statoTestRealeVariant: Record<StatoTestReale, string> = {
  test_reale_pronto: "bg-fuchsia-900/40 text-fuchsia-200 border-fuchsia-800",
  in_attesa: "bg-secondary text-muted-foreground",
  non_applicabile: "bg-slate-800 text-slate-300 border-slate-700",
};

const maturitaLabel: Record<MaturitaDato, string> = {
  demo_operativa: "Demo operativa",
  da_verificare: "Da verificare",
  verificato: "Verificato",
};

const maturitaVariant: Record<MaturitaDato, string> = {
  demo_operativa: "bg-sky-900/40 text-sky-200 border-sky-800",
  da_verificare: "bg-amber-900/40 text-amber-200 border-amber-800",
  verificato: "bg-emerald-900/40 text-emerald-200 border-emerald-800",
};

// Note interne brevi, non tecnico-commerciali.
const NOTE_INTERNE: Record<string, string> = {
  "Padova-Arcella": "Candidata principale al primo test reale: domanda viva, offerta abbondante.",
  "Padova-Centro Storico": "Microzona simbolica del pilota, da trattare con prudenza.",
  "Padova-Portello": "Forte componente investitori, utile come banco di prova secondario.",
  "Padova-Forcellini": "Zona residenziale stabile, buon equilibrio per primi confronti.",
  "Padova-Guizza": "Sensibile al prezzo, utile per testare il posizionamento.",
  "Padova-Sacra Famiglia": "Zona di osservazione, segnali ancora da consolidare.",
  "Padova-Stanga": "Da completare prima di considerarla operativa.",
  "Albignasego-Albignasego": "Prima cintura, candidata di riserva per test reali.",
  "Selvazzano Dentro-Selvazzano Dentro": "Premium di cintura, gestione cauta.",
  "Abano Terme-Abano Terme": "Mercato termale, attenzione alla stagionalità.",
};

function buildRighe(): RigaFase1[] {
  const territorio = TERRITORI_CIVIKO_ONE[0];
  return territorio.microzone.map((m) => {
    const opportunita = OPPORTUNITA_PILOTA.filter(
      (o) => o.microzona === m.nome && o.comune === m.comune,
    );
    const dossier = DOSSIER_AGENZIA.filter(
      (d) => d.microzona === m.nome && d.comune === m.comune,
    );
    const servizi = !!getServiziProssimita(m.comune, m.nome);
    const opp = opportunita.length;
    const stato = deriveStato(m);
    const key = `${m.comune}-${m.nome}`;
    const isTestReale = key === TEST_REALE_KEY;
    const prioritaBase = derivePriorita(m, opp);
    const priorita: PrioritaOperativa = isTestReale ? "massima" : prioritaBase;
    const maturita = deriveMaturita(m, opp, servizi);
    const nota = isTestReale
      ? "Prima microzona test reale del pilota Padova: priorità massima, popolamento dati reali da preparare con cautela."
      : NOTE_INTERNE[key] ?? m.noteOperativeInterne ?? "Nessuna nota interna registrata.";
    const prontaPerTestReali =
      stato === "fase_1" &&
      m.stato === "attivo" &&
      prioritaBase === "alta" &&
      maturita === "demo_operativa";
    const statoTestReale: StatoTestReale = isTestReale
      ? "test_reale_pronto"
      : stato === "fase_1"
        ? "in_attesa"
        : "non_applicabile";

    return {
      microzona: m,
      statoFase: stato,
      priorita,
      maturita,
      attivo: m.stato === "attivo",
      opportunita: opp,
      dossier: dossier.length,
      serviziDisponibili: servizi,
      notaInterna: nota,
      prontaPerTestReali,
      isTestReale,
      statoTestReale,
    };
  });
}

type FilterKey = "fase_1" | "in_osservazione" | "futura" | "tutte";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "fase_1", label: "Fase 1" },
  { key: "in_osservazione", label: "In osservazione" },
  { key: "futura", label: "Futura" },
  { key: "tutte", label: "Tutte" },
];

function RigaCard({ r }: { r: RigaFase1 }) {
  const m = r.microzona;
  return (
    <Card className={r.isTestReale ? "border-fuchsia-700/60 ring-1 ring-fuchsia-700/30" : undefined}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{m.nome}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {m.comune} · {CLUSTER_LABEL[m.cluster]} · <span className="capitalize">{m.fasciaPercepita}</span>
            </p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {r.isTestReale && (
                <Badge variant="outline" className={`text-[10px] ${statoTestRealeVariant.test_reale_pronto}`}>
                  Microzona test reale
                </Badge>
              )}
              <Badge variant="outline" className={`text-[10px] ${statoFaseVariant[r.statoFase]}`}>
                {statoFaseLabel[r.statoFase]}
              </Badge>
              <Badge variant="outline" className={`text-[10px] ${prioritaVariant[r.priorita]}`}>
                Priorità {r.priorita}
              </Badge>
              <Badge variant="outline" className={`text-[10px] ${maturitaVariant[r.maturita]}`}>
                {maturitaLabel[r.maturita]}
              </Badge>
              {!r.isTestReale && r.prontaPerTestReali && (
                <Badge variant="outline" className="text-[10px] bg-emerald-900/40 text-emerald-200 border-emerald-800">
                  Pronta per test reali
                </Badge>
              )}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Stato attivo</span>
          <span>{r.attivo ? "Sì" : "No"}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Opportunità attive</span>
          <span className="font-mono">{r.opportunita}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Dossier collegati</span>
          <span className="font-mono">{r.dossier}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Servizi di prossimità</span>
          <span>{r.serviziDisponibili ? "Sì" : "No"}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Stato test reale</span>
          <Badge variant="outline" className={`text-[10px] ${statoTestRealeVariant[r.statoTestReale]}`}>
            {statoTestRealeLabel[r.statoTestReale]}
          </Badge>
        </div>
        <div className="pt-2 border-t border-border">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Nota interna</p>
          <p className="text-xs leading-relaxed">{r.notaInterna}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function MicrozoneFase1Page() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("fase_1");

  const righe = useMemo(buildRighe, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return righe.filter((r) => {
      if (filter !== "tutte" && r.statoFase !== filter) return false;
      if (!q) return true;
      return (
        r.microzona.nome.toLowerCase().includes(q) ||
        r.microzona.comune.toLowerCase().includes(q) ||
        CLUSTER_LABEL[r.microzona.cluster].toLowerCase().includes(q)
      );
    });
  }, [righe, filter, query]);

  const fase1 = righe.filter((r) => r.statoFase === "fase_1");
  const totFase1 = fase1.length;
  const oppCollegate = fase1.reduce((acc, r) => acc + r.opportunita, 0);
  const dossierCollegati = fase1.reduce((acc, r) => acc + r.dossier, 0);
  const pronteTestReali = fase1.filter((r) => r.prontaPerTestReali).length;
  const testReale = righe.find((r) => r.isTestReale);
  const altreFase1InAttesa = fase1.filter((r) => !r.isTestReale).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Microzone Fase 1</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Selezione ristretta di microzone prioritarie del pilota{" "}
            <span className="font-medium">Padova e provincia</span>. Base ordinata per i primi
            test con dati reali e per l'evoluzione di opportunità, dossier e sintesi.
          </p>
        </div>
        <Badge variant="outline">PWA principale: Metodo Civiko One</Badge>
      </div>

      {testReale && (
        <Card className="border-fuchsia-700/60 bg-fuchsia-950/10">
          <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-wide text-fuchsia-300">
                Microzona test selezionata
              </p>
              <p className="text-lg font-semibold">
                {testReale.microzona.nome}{" "}
                <span className="text-sm text-muted-foreground font-normal">
                  · {testReale.microzona.comune}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                Prima e unica microzona attivata per il popolamento dati reali. Le altre Fase 1 restano in attesa.
              </p>
            </div>
            <div className="text-right">
              <Badge variant="outline" className={statoTestRealeVariant.test_reale_pronto}>
                {statoTestRealeLabel.test_reale_pronto}
              </Badge>
              <p className="text-xs text-muted-foreground mt-2">
                Altre microzone Fase 1 in attesa: <span className="font-mono">{altreFase1InAttesa}</span>
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Microzone Fase 1</p>
            <p className="text-2xl font-bold mt-1">{totFase1}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Opportunità collegate</p>
            <p className="text-2xl font-bold mt-1">{oppCollegate}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Dossier collegati</p>
            <p className="text-2xl font-bold mt-1">{dossierCollegati}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Pronte per test reali</p>
            <p className="text-2xl font-bold mt-1">{pronteTestReali}</p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-dashed">
        <CardContent className="p-4 text-xs text-muted-foreground space-y-1">
          <p>
            La marcatura <span className="font-medium">Fase 1</span> deriva dal campo{" "}
            <span className="font-mono">fasePilota</span> già presente nel territorio pilota: nessuna
            microzona viene creata qui, solo selezionata e arricchita con priorità operativa, maturità
            del dato e nota interna.
          </p>
          <p>
            Le microzone <span className="font-medium">in osservazione</span> ({FASE_LABEL.fase_2})
            restano predisposte. Le <span className="font-medium">future</span> sono solo
            tracciate.
          </p>
        </CardContent>
      </Card>

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
          {filtered.map((r) => (
            <RigaCard key={`${r.microzona.comune}-${r.microzona.nome}`} r={r} />
          ))}
        </div>
      )}
    </div>
  );
}
