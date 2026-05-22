import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TERRITORI_CIVIKO_ONE, CLUSTER_LABEL } from "@/data/civiko-one-territori";
import { OPPORTUNITA_PILOTA } from "@/data/civiko-one-opportunita-pilota";
import { DOSSIER_AGENZIA } from "@/data/civiko-one-dossier-agenzia";
import { getServiziProssimita } from "@/data/civiko-one-servizi-prossimita";
import { DemoDataBanner } from "@/components/DemoDataBanner";

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
      { testo: "Prime opportunità candidate identificate", stato: "completato" },
      { testo: "Opportunità validate come coerenti con la microzona", stato: "completato" },
      { testo: "Priorità operativa assegnata alle candidate", stato: "completato" },
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
      { testo: "Note operative compilate", stato: "completato" },
      { testo: "Revisione interna effettuata", stato: "completato" },
      { testo: "Pronto per primo test dati reali", stato: "completato" },
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

type StatoSegnale = "verificato" | "da_confermare";

interface SegnaleTerritoriale {
  nome: string;
  livello: string;
  nota?: string;
  stato: StatoSegnale;
}

const SEGNALI_TERRITORIALI_ARCELLA: SegnaleTerritoriale[] = [
  {
    nome: "Domanda percepita",
    livello: "Forte",
    nota: "Famiglie e piccoli investitori attivi sul mercato",
    stato: "verificato",
  },
  {
    nome: "Offerta percepita",
    livello: "Media",
    nota: "Rotazione regolare, non ecceduta",
    stato: "verificato",
  },
  {
    nome: "Attrattività residenziale",
    livello: "Media",
    nota: "Servizi e trasporti sostengono la zona",
    stato: "verificato",
  },
  {
    nome: "Pressione competitiva",
    livello: "Media",
    nota: "Agenti presenti ma domanda sostiene il flusso",
    stato: "da_confermare",
  },
  {
    nome: "Dinamicità della zona",
    livello: "Media",
    nota: "Contesto stabile con movimento costante",
    stato: "verificato",
  },
  {
    nome: "Tipologie prevalenti",
    livello: "Appartamenti medio-piccoli",
    nota: "Primari e ristrutturati con interesse",
    stato: "verificato",
  },
];

const statoSegnaleVariant: Record<StatoSegnale, string> = {
  verificato: "bg-emerald-900/40 text-emerald-200 border-emerald-800",
  da_confermare: "bg-amber-900/40 text-amber-200 border-amber-800",
};

const statoSegnaleLabel: Record<StatoSegnale, string> = {
  verificato: "Verificato",
  da_confermare: "Da confermare",
};

type PrioritaOpportunita = "alta" | "media" | "bassa";
type StatoOpportunita = "verificata" | "da_confermare";

interface OpportunitaCandidate {
  titolo: string;
  tipologia: string;
  coerenza: string;
  priorita: PrioritaOpportunita;
  stato: StatoOpportunita;
  nota?: string;
}

const OPPORTUNITA_CANDIDATE_ARCELLA: OpportunitaCandidate[] = [
  {
    titolo: "Famiglie in cerca di appartamento ristrutturato",
    tipologia: "Appartamento medio-piccolo",
    coerenza: "Forte",
    priorita: "alta",
    stato: "verificata",
    nota: "Domanda attiva su zona popolare con servizi",
  },
  {
    titolo: "Piccolo investitore su affitto",
    tipologia: "Bilocale / trilocale",
    coerenza: "Forte",
    priorita: "media",
    stato: "verificata",
    nota: "Buona accessibilità e servizi sostengono rendimento",
  },
  {
    titolo: "Prima casa giovane coppia",
    tipologia: "Appartamento medio",
    coerenza: "Media",
    priorita: "media",
    stato: "da_confermare",
    nota: "Interesse sostenuto da trasporti e prezzi contenuti",
  },
];

const prioritaVariant: Record<PrioritaOpportunita, string> = {
  alta: "bg-rose-900/40 text-rose-200 border-rose-800",
  media: "bg-sky-900/40 text-sky-200 border-sky-800",
  bassa: "bg-slate-800 text-slate-300 border-slate-700",
};

const prioritaLabel: Record<PrioritaOpportunita, string> = {
  alta: "Alta",
  media: "Media",
  bassa: "Bassa",
};

const statoOpportunitaVariant: Record<StatoOpportunita, string> = {
  verificata: "bg-emerald-900/40 text-emerald-200 border-emerald-800",
  da_confermare: "bg-amber-900/40 text-amber-200 border-amber-800",
};

const statoOpportunitaLabel: Record<StatoOpportunita, string> = {
  verificata: "Verificata",
  da_confermare: "Da confermare",
};

type StatoAsset = "osservato" | "in_verifica";

interface AssetOsservato {
  etichetta: string;
  tipologia: string;
  coerenzaOpportunita: string;
  stato: StatoAsset;
  nota?: string;
}

const ASSET_OSSERVATI_ARCELLA: AssetOsservato[] = [
  {
    etichetta: "Appartamento medio-piccolo ristrutturato",
    tipologia: "Appartamento",
    coerenzaOpportunita: "Famiglie in cerca di appartamento ristrutturato",
    stato: "osservato",
    nota: "Tipologia coerente con domanda attiva verificata",
  },
  {
    etichetta: "Bilocale / trilocale da investimento",
    tipologia: "Bilocale / trilocale",
    coerenzaOpportunita: "Piccolo investitore su affitto",
    stato: "osservato",
    nota: "Formato richiesto dal target investitori",
  },
  {
    etichetta: "Appartamento medio per prima casa",
    tipologia: "Appartamento",
    coerenzaOpportunita: "Prima casa giovane coppia",
    stato: "in_verifica",
    nota: "In verifica rispetto alla fascia di prezzo percepita",
  },
];

const statoAssetVariant: Record<StatoAsset, string> = {
  osservato: "bg-emerald-900/40 text-emerald-200 border-emerald-800",
  in_verifica: "bg-amber-900/40 text-amber-200 border-amber-800",
};

const statoAssetLabel: Record<StatoAsset, string> = {
  osservato: "Osservato",
  in_verifica: "In verifica",
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
      <DemoDataBanner
        title="Anteprima dimostrativa — Arcella"
        description="Questa pagina mostra la struttura interna di una checklist di test su una microzona pilota (Arcella) usando un dataset di esempio. I valori (opportunità, dossier, servizi) non rappresentano dati reali. I test reali e i dossier operativi vengono generati dalla dashboard AcquisitionRadar."
      />

      {/* Nota interna approvazione */}
      <Card className="border-emerald-800/50 bg-emerald-950/20">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5">
              <Badge
                variant="outline"
                className="bg-emerald-900/40 text-emerald-200 border-emerald-800 text-[10px]"
              >
                Base pilota interna · Dati dimostrativi
              </Badge>
            </div>
            <div>
              <p className="text-sm font-medium text-emerald-100">
                Arcella è la microzona di esempio usata come base pilota interna
              </p>
              <p className="text-xs text-emerald-200/70 mt-1">
                Checklist e struttura verificate internamente sul dataset dimostrativo. Nessun provider esterno attivo, nessuno scraping in corso.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            Test Reale Arcella
            <Badge variant="outline">Anteprima esempio</Badge>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Contenitore interno dimostrativo per la microzona{" "}
            <span className="font-medium">Arcella · Padova</span>. Struttura predisposta su
            dataset di esempio, nessun popolamento con dati reali.
          </p>
        </div>
        <Badge
          variant="outline"
          className="bg-emerald-900/40 text-emerald-200 border-emerald-800"
        >
          Microzona test approvata
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
              className="mt-1 bg-emerald-900/40 text-emerald-200 border-emerald-800"
            >
              Test reale completato
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
          Arcella è la prima microzona test reale completata internamente come base pilota.
          I dati raccolti sono leggeri e controllati: nessun provider esterno attivo, nessuno scraping in corso, nessun job automatico pianificato.
        </CardContent>
      </Card>

      {/* Blocchi predisposti */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {BLOCCHI.map((b) =>
          b.id === "segnali_territoriali" ? (
            <Card key={b.id} className="border-dashed">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{b.titolo}</CardTitle>
                  <Badge variant="outline" className="bg-fuchsia-900/40 text-fuchsia-200 border-fuchsia-800 text-[10px]">
                    Primo test reale
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground leading-relaxed">{b.descrizione}</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[10px] bg-sky-900/40 text-sky-200 border-sky-800">
                    Parzialmente popolato
                  </Badge>
                </div>
                <div className="space-y-2">
                  {SEGNALI_TERRITORIALI_ARCELLA.map((s, idx) => (
                    <div
                      key={idx}
                      className="flex items-start justify-between gap-2 text-xs leading-relaxed"
                    >
                      <div className="flex flex-col">
                        <span className="font-medium">{s.nome}</span>
                        <span className="text-[10px] text-muted-foreground">{s.nota}</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] text-muted-foreground">{s.livello}</span>
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${statoSegnaleVariant[s.stato]}`}
                        >
                          {statoSegnaleLabel[s.stato]}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : b.id === "opportunita_candidate" ? (
            <Card key={b.id} className="border-dashed">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{b.titolo}</CardTitle>
                  <Badge variant="outline" className="bg-fuchsia-900/40 text-fuchsia-200 border-fuchsia-800 text-[10px]">
                    Primo test reale
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground leading-relaxed">{b.descrizione}</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[10px] bg-sky-900/40 text-sky-200 border-sky-800">
                    Parzialmente popolato
                  </Badge>
                </div>
                <div className="space-y-2">
                  {OPPORTUNITA_CANDIDATE_ARCELLA.map((o, idx) => (
                    <div
                      key={idx}
                      className="flex flex-col gap-1 text-xs leading-relaxed border-b border-border/50 pb-2 last:border-0 last:pb-0"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium">{o.titolo}</span>
                        <Badge
                          variant="outline"
                          className={`shrink-0 text-[10px] ${prioritaVariant[o.priorita]}`}
                        >
                          {prioritaLabel[o.priorita]}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span>{o.tipologia}</span>
                        <span>·</span>
                        <span>Coerenza {o.coerenza.toLowerCase()}</span>
                      </div>
                      {o.nota && (
                        <span className="text-[10px] text-muted-foreground">{o.nota}</span>
                      )}
                      <div className="flex justify-end">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${statoOpportunitaVariant[o.stato]}`}
                        >
                          {statoOpportunitaLabel[o.stato]}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : b.id === "immobili_osservati" ? (
            <Card key={b.id} className="border-dashed">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{b.titolo}</CardTitle>
                  <Badge variant="outline" className="bg-fuchsia-900/40 text-fuchsia-200 border-fuchsia-800 text-[10px]">
                    Primo test reale
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground leading-relaxed">{b.descrizione}</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[10px] bg-sky-900/40 text-sky-200 border-sky-800">
                    Parzialmente popolato
                  </Badge>
                </div>
                <div className="space-y-2">
                  {ASSET_OSSERVATI_ARCELLA.map((a, idx) => (
                    <div
                      key={idx}
                      className="flex flex-col gap-1 text-xs leading-relaxed border-b border-border/50 pb-2 last:border-0 last:pb-0"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium">{a.etichetta}</span>
                        <Badge
                          variant="outline"
                          className={`shrink-0 text-[10px] ${statoAssetVariant[a.stato]}`}
                        >
                          {statoAssetLabel[a.stato]}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span>{a.tipologia}</span>
                        <span>·</span>
                        <span>{a.coerenzaOpportunita}</span>
                      </div>
                      {a.nota && (
                        <span className="text-[10px] text-muted-foreground">{a.nota}</span>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : b.id === "servizi_verificati" ? (
            <Card key={b.id} className="border-dashed">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{b.titolo}</CardTitle>
                  <Badge variant="outline" className="bg-fuchsia-900/40 text-fuchsia-200 border-fuchsia-800 text-[10px]">
                    Primo test reale
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground leading-relaxed">{b.descrizione}</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[10px] bg-sky-900/40 text-sky-200 border-sky-800">
                    Parzialmente popolato
                  </Badge>
                </div>
                <div className="space-y-3">
                  {SERVIZI_VERIFICATI_ARCELLA.map((gruppo) => (
                    <div key={gruppo.categoria}>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        {gruppo.categoria}
                      </p>
                      <ul className="space-y-1.5">
                        {gruppo.elementi.map((el, idx) => (
                          <li
                            key={idx}
                            className="flex items-start justify-between gap-2 text-xs leading-relaxed"
                          >
                            <div className="flex flex-col">
                              <span>{el.nome}</span>
                              {el.nota && (
                                <span className="text-[10px] text-muted-foreground">{el.nota}</span>
                              )}
                            </div>
                            <Badge
                              variant="outline"
                              className={`shrink-0 text-[10px] ${presenzaVariant[el.presenza] || "bg-slate-800 text-slate-300 border-slate-700"}`}
                            >
                              {el.presenza}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : (
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
          )
        )}
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
              { testo: "Tipologie prevalenti", stato: "raccolto" },
              { testo: "Fascia di domanda percepita", stato: "raccolto" },
              { testo: "Fascia di offerta percepita", stato: "raccolto" },
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
              { testo: "Prime opportunità candidate osservabili", stato: "raccolto" },
              { testo: "Coerenza con la microzona verificata", stato: "raccolto" },
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
