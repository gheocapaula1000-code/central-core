import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TERRITORI_CIVIKO_ONE, CLUSTER_LABEL } from "@/data/civiko-one-territori";
import { OPPORTUNITA_PILOTA } from "@/data/civiko-one-opportunita-pilota";
import { DOSSIER_AGENZIA } from "@/data/civiko-one-dossier-agenzia";
import { getServiziProssimita } from "@/data/civiko-one-servizi-prossimita";

const ARCELLA_NOME = "Arcella";
const ARCELLA_COMUNE = "Padova";

interface BloccoPredisposto {
  id: string;
  titolo: string;
  descrizione: string;
}

type StatoVoce = "da_fare" | "in_verifica" | "completato";

interface VoceChecklist {
  testo: string;
  stato: StatoVoce;
}

interface BloccoChecklist {
  id: string;
  titolo: string;
  voci: VoceChecklist[];
}

const CHECKLIST: BloccoChecklist[] = [
  {
    id: "territorio_perimetro",
    titolo: "Territorio e perimetro",
    voci: [
      { testo: "Perimetro microzona Arcella confermato", stato: "da_fare" },
      { testo: "Cluster commerciale coerente verificato", stato: "da_fare" },
      { testo: "Confini con microzone limitrofe chiariti", stato: "da_fare" },
    ],
  },
  {
    id: "opportunita_candidate",
    titolo: "Opportunità candidate",
    voci: [
      { testo: "Prime opportunità candidate identificate", stato: "da_fare" },
      { testo: "Opportunità validate come coerenti con la microzona", stato: "da_fare" },
      { testo: "Priorità operativa assegnata alle candidate", stato: "da_fare" },
    ],
  },
  {
    id: "servizi_prossimita",
    titolo: "Servizi di prossimità",
    voci: [
      { testo: "Servizi minimi verificabili sul territorio", stato: "da_fare" },
      { testo: "Lettura sintetica confermata sul campo", stato: "da_fare" },
    ],
  },
  {
    id: "dossier_collegabili",
    titolo: "Dossier collegabili",
    voci: [
      { testo: "Almeno un dossier collegabile preparato", stato: "da_fare" },
      { testo: "Dossier coerente con la microzona Arcella", stato: "da_fare" },
    ],
  },
  {
    id: "stato_validazione",
    titolo: "Stato di validazione",
    voci: [
      { testo: "Note operative compilate", stato: "da_fare" },
      { testo: "Revisione interna effettuata", stato: "da_fare" },
      { testo: "Pronto per primo test dati reali", stato: "da_fare" },
    ],
  },
];

const statoVoceLabel: Record<StatoVoce, string> = {
  da_fare: "Da fare",
  in_verifica: "In verifica",
  completato: "Completato",
};

const statoVoceVariant: Record<StatoVoce, string> = {
  da_fare: "bg-slate-800 text-slate-300 border-slate-700",
  in_verifica: "bg-amber-900/40 text-amber-200 border-amber-800",
  completato: "bg-emerald-900/40 text-emerald-200 border-emerald-800",
};

const BLOCCHI: BloccoPredisposto[] = [
  {
    id: "segnali_territoriali",
    titolo: "Segnali territoriali",
    descrizione:
      "Indicatori interni sulla microzona (domanda, offerta, sentiment). Verranno popolati con dati reali in fase di test.",
  },
  {
    id: "opportunita_candidate",
    titolo: "Opportunità candidate",
    descrizione:
      "Lista delle opportunità da consolidare e validare durante il primo test reale su Arcella.",
  },
  {
    id: "immobili_osservati",
    titolo: "Immobili / asset osservati",
    descrizione:
      "Asset selezionati come riferimento operativo. Nessun immobile ancora associato.",
  },
  {
    id: "servizi_verificati",
    titolo: "Servizi di prossimità verificati",
    descrizione:
      "Verifica puntuale dei servizi della zona oltre la lettura sintetica già disponibile.",
  },
  {
    id: "note_operative",
    titolo: "Note operative",
    descrizione:
      "Annotazioni interne raccolte durante la preparazione e l'esecuzione del test reale.",
  },
  {
    id: "stato_validazione",
    titolo: "Stato validazione",
    descrizione:
      "Esito della validazione qualitativa dei dati raccolti su Arcella.",
  },
];

export default function TestRealeArcellaPage() {
  const territorio = TERRITORI_CIVIKO_ONE[0];
  const microzona = territorio.microzone.find(
    (m) => m.nome === ARCELLA_NOME && m.comune === ARCELLA_COMUNE,
  );

  const opportunita = OPPORTUNITA_PILOTA.filter(
    (o) => o.microzona === ARCELLA_NOME && o.comune === ARCELLA_COMUNE,
  );
  const dossier = DOSSIER_AGENZIA.filter(
    (d) => d.microzona === ARCELLA_NOME && d.comune === ARCELLA_COMUNE,
  );
  const servizi = !!getServiziProssimita(ARCELLA_COMUNE, ARCELLA_NOME);
  const maturita: "demo_operativa" | "da_verificare" =
    opportunita.length > 0 && servizi ? "demo_operativa" : "da_verificare";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Test Reale Arcella</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Contenitore interno per il primo test con dati reali sulla microzona{" "}
            <span className="font-medium">Arcella · Padova</span>. Struttura predisposta, nessun
            popolamento attivo.
          </p>
        </div>
        <Badge
          variant="outline"
          className="bg-fuchsia-900/40 text-fuchsia-200 border-fuchsia-800"
        >
          Preparazione completata
        </Badge>
      </div>

      {/* Sintesi */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Microzona selezionata</p>
            <p className="font-semibold mt-1">
              {ARCELLA_NOME}
              <span className="text-xs text-muted-foreground font-normal"> · {ARCELLA_COMUNE}</span>
            </p>
            {microzona && (
              <p className="text-[10px] text-muted-foreground mt-1">
                {CLUSTER_LABEL[microzona.cluster]}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Stato test</p>
            <Badge
              variant="outline"
              className="mt-1 bg-fuchsia-900/40 text-fuchsia-200 border-fuchsia-800"
            >
              In attesa di primo test reale
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Maturità dato</p>
            <Badge
              variant="outline"
              className={
                maturita === "demo_operativa"
                  ? "mt-1 bg-sky-900/40 text-sky-200 border-sky-800"
                  : "mt-1 bg-amber-900/40 text-amber-200 border-amber-800"
              }
            >
              {maturita === "demo_operativa" ? "Demo operativa" : "Da verificare"}
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Opportunità collegate</p>
            <p className="text-2xl font-bold mt-1">{opportunita.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Dossier collegati</p>
            <p className="text-2xl font-bold mt-1">{dossier.length}</p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-dashed">
        <CardContent className="p-4 text-xs text-muted-foreground">
          La struttura è pronta per ricevere dati reali esclusivamente per Arcella. Nessun
          provider esterno è attivo, nessuno scraping è in corso, nessun job automatico è
          pianificato. I blocchi qui sotto sono predisposti e non ancora popolati.
        </CardContent>
      </Card>

      {/* Blocchi predisposti */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {BLOCCHI.map((b) => (
          <Card key={b.id} className="border-dashed">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base">{b.titolo}</CardTitle>
                <Badge variant="outline" className="bg-secondary text-muted-foreground text-[10px]">
                  Predisposto
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground leading-relaxed">{b.descrizione}</p>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline" className="text-[10px] bg-slate-800 text-slate-300 border-slate-700">
                  Non ancora popolato
                </Badge>
                <Badge variant="outline" className="text-[10px] bg-fuchsia-900/30 text-fuchsia-200 border-fuchsia-800">
                  In attesa di primo test reale
                </Badge>
              </div>
              <div className="rounded border border-dashed border-border p-3 text-[11px] text-muted-foreground italic">
                Nessun contenuto disponibile. Verrà compilato in fase di test reale.
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
