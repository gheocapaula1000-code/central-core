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
      { testo: "Servizi minimi verificabili sul territorio", stato: "completato" },
      { testo: "Lettura sintetica confermata sul campo", stato: "completato" },
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

interface ServizioVerificato {
  categoria: string;
  elementi: { nome: string; presenza: string; nota?: string }[];
}

const SERVIZI_VERIFICATI_ARCELLA: ServizioVerificato[] = [
  {
    categoria: "Trasporti",
    elementi: [
      { nome: "Fermate bus / tram", presenza: "Forte presenza", nota: "Linee verso centro e tangenziali" },
    ],
  },
  {
    categoria: "Scuole",
    elementi: [
      { nome: "Scuole primarie e secondarie", presenza: "Presenza media", nota: "Copertura nel raggio microzona" },
      { nome: "Asili", presenza: "Presenza media" },
    ],
  },
  {
    categoria: "Spesa e alimentari",
    elementi: [
      { nome: "Supermercati", presenza: "Forte presenza", nota: "Punti vendita di medie dimensioni" },
      { nome: "Alimentari / botteghe", presenza: "Forte presenza" },
    ],
  },
  {
    categoria: "Servizi quotidiani essenziali",
    elementi: [
      { nome: "Farmacie", presenza: "Presenza media" },
      { nome: "Tabacchini", presenza: "Forte presenza" },
      { nome: "Poste", presenza: "Presenza media", nota: "Sportello nel raggio operativo" },
    ],
  },
];

const presenzaVariant: Record<string, string> = {
  "Forte presenza": "bg-emerald-900/40 text-emerald-200 border-emerald-800",
  "Presenza media": "bg-sky-900/40 text-sky-200 border-sky-800",
  "Presenza limitata": "bg-amber-900/40 text-amber-200 border-amber-800",
};

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
              {maturita === "demo_operativa" ? "Preparazione completata" : "Da verificare"}
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

      {/* Checklist Test Reale */}
      {(() => {
        const tutteVoci = CHECKLIST.flatMap((b) => b.voci);
        const totale = tutteVoci.length;
        const completate = tutteVoci.filter((v) => v.stato === "completato").length;
        const inVerifica = tutteVoci.filter((v) => v.stato === "in_verifica").length;
        const daFare = tutteVoci.filter((v) => v.stato === "da_fare").length;
        return (
          <section className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Checklist Test Reale</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Elementi da raccogliere, controllare e validare prima di considerare Arcella pronta al
                primo test con dati reali. Stato iniziale di tutte le voci: da fare.
              </p>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">Totale voci</p>
                  <p className="text-2xl font-bold mt-1">{totale}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">Completate</p>
                  <p className="text-2xl font-bold mt-1">{completate}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">In verifica</p>
                  <p className="text-2xl font-bold mt-1">{inVerifica}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">Da fare</p>
                  <p className="text-2xl font-bold mt-1">{daFare}</p>
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {CHECKLIST.map((blocco) => (
                <Card key={blocco.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{blocco.titolo}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2">
                      {blocco.voci.map((v, i) => (
                        <li
                          key={i}
                          className="flex items-start justify-between gap-3 text-xs leading-relaxed"
                        >
                          <span>{v.testo}</span>
                          <Badge
                            variant="outline"
                            className={`shrink-0 text-[10px] ${statoVoceVariant[v.stato]}`}
                          >
                            {statoVoceLabel[v.stato]}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        );
      })()}

      {/* Set minimo dati reali */}
      {(() => {
        type StatoElemento = "raccolto" | "non_raccolto";
        interface ElementoSet {
          testo: string;
          stato: StatoElemento;
        }
        interface BloccoSet {
          id: string;
          titolo: string;
          elementi: ElementoSet[];
        }
        const SET_MINIMO: BloccoSet[] = [
          {
            id: "identita_microzona",
            titolo: "Identità microzona",
            elementi: [
              { testo: "Nome microzona confermato", stato: "non_raccolto" },
              { testo: "Perimetro operativo confermato", stato: "non_raccolto" },
              { testo: "Cluster commerciale confermato", stato: "non_raccolto" },
            ],
          },
          {
            id: "segnali_immobiliari",
            titolo: "Segnali immobiliari di base",
            elementi: [
              { testo: "Tipologie prevalenti", stato: "non_raccolto" },
              { testo: "Fascia di domanda percepita", stato: "non_raccolto" },
              { testo: "Fascia di offerta percepita", stato: "non_raccolto" },
            ],
          },
          {
            id: "servizi_essenziali",
            titolo: "Servizi di prossimità essenziali",
            elementi: [
              { testo: "Primi servizi di prossimità essenziali", stato: "raccolto" },
              { testo: "Lettura sintetica della zona", stato: "raccolto" },
            ],
          },
          {
            id: "opportunita_minime",
            titolo: "Opportunità candidate minime",
            elementi: [
              { testo: "Prime opportunità candidate osservabili", stato: "non_raccolto" },
              { testo: "Coerenza con la microzona verificata", stato: "non_raccolto" },
            ],
          },
          {
            id: "note_operative",
            titolo: "Note operative",
            elementi: [
              { testo: "Almeno una nota operativa utile", stato: "non_raccolto" },
            ],
          },
        ];

        const tutti = SET_MINIMO.flatMap((b) => b.elementi);
        const totale = tutti.length;
        const raccolti = tutti.filter((e) => e.stato === "raccolto").length;
        const nonRaccolti = totale - raccolti;

        const statoLabel: Record<StatoElemento, string> = {
          raccolto: "Raccolto",
          non_raccolto: "Non raccolto",
        };
        const statoVariant: Record<StatoElemento, string> = {
          raccolto: "bg-emerald-900/40 text-emerald-200 border-emerald-800",
          non_raccolto: "bg-slate-800 text-slate-300 border-slate-700",
        };

        return (
          <section className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Set minimo dati reali</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Primo pacchetto minimo di dati reali da raccogliere su Arcella prima di
                attivare qualsiasi provider o automazione. Stato iniziale di tutti gli elementi: non raccolto.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">Totale elementi</p>
                  <p className="text-2xl font-bold mt-1">{totale}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">Raccolti</p>
                  <p className="text-2xl font-bold mt-1">{raccolti}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">Non raccolti</p>
                  <p className="text-2xl font-bold mt-1">{nonRaccolti}</p>
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {SET_MINIMO.map((blocco) => (
                <Card key={blocco.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{blocco.titolo}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2">
                      {blocco.elementi.map((e, i) => (
                        <li
                          key={i}
                          className="flex items-start justify-between gap-3 text-xs leading-relaxed"
                        >
                          <span>{e.testo}</span>
                          <Badge
                            variant="outline"
                            className={`shrink-0 text-[10px] ${statoVariant[e.stato]}`}
                          >
                            {statoLabel[e.stato]}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        );
      })()}
    </div>
  );
}
