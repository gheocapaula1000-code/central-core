// Territori — Metodo Civiko One
// Dataset interno Core. Non esporre fonti grezze, payload o log.
// Visibilità: dati interni Core. Sottoinsiemi possono essere esposti
// alla PWA agenzie tramite endpoint dedicati (mai direttamente questo file).

export type FasciaPercepita = "popolare" | "media" | "medio-alta" | "alta" | "prestige";
export type SentimentCommerciale = "freddo" | "tiepido" | "stabile" | "caldo" | "molto_caldo";
export type ClusterTerritoriale =
  | "padova_centro"
  | "padova_nord"
  | "padova_sud"
  | "padova_est"
  | "padova_ovest"
  | "cintura_nord"
  | "cintura_sud"
  | "cintura_est"
  | "cintura_ovest"
  | "terme_euganee";

export interface Microzona {
  nome: string;
  comune: string;
  cluster: ClusterTerritoriale;
  fasciaPercepita: FasciaPercepita;
  tipologiePrevalenti: string[];
  domandaStimata: "bassa" | "media" | "alta" | "molto_alta";
  offertaStimata: "bassa" | "media" | "alta" | "molto_alta";
  sentimentCommerciale: SentimentCommerciale;
  rangePrezzoIndicativoEurMq: { min: number; max: number };
  tempiStimatiVenditaMesi: { min: number; max: number };
  noteOperativeInterne: string;
  ultimoAggiornamento: string; // ISO date
}

export interface TerritorioPilota {
  id: string;
  nome: string;
  stato: "attivo" | "preparazione" | "sospeso";
  pwa: string;
  cluster: ClusterTerritoriale[];
  microzone: Microzona[];
}

const today = "2026-05-13";

export const TERRITORI_CIVIKO_ONE: TerritorioPilota[] = [
  {
    id: "padova_e_provincia",
    nome: "Padova e provincia",
    stato: "attivo",
    pwa: "civiko_one",
    cluster: [
      "padova_centro",
      "padova_nord",
      "padova_sud",
      "padova_est",
      "padova_ovest",
      "cintura_nord",
      "cintura_sud",
      "cintura_est",
      "cintura_ovest",
      "terme_euganee",
    ],
    microzone: [
      { nome: "Centro Storico", comune: "Padova", cluster: "padova_centro", fasciaPercepita: "alta", tipologiePrevalenti: ["bilocale", "trilocale", "attico"], domandaStimata: "alta", offertaStimata: "media", sentimentCommerciale: "caldo", rangePrezzoIndicativoEurMq: { min: 3200, max: 4800 }, tempiStimatiVenditaMesi: { min: 2, max: 5 }, noteOperativeInterne: "Tagli piccoli muovono velocemente, attico premium su Piazze.", ultimoAggiornamento: today },
      { nome: "Portello", comune: "Padova", cluster: "padova_centro", fasciaPercepita: "medio-alta", tipologiePrevalenti: ["bilocale studenti", "trilocale"], domandaStimata: "alta", offertaStimata: "media", sentimentCommerciale: "caldo", rangePrezzoIndicativoEurMq: { min: 2600, max: 3700 }, tempiStimatiVenditaMesi: { min: 2, max: 5 }, noteOperativeInterne: "Forte componente investitori per affitto universitario.", ultimoAggiornamento: today },
      { nome: "Arcella", comune: "Padova", cluster: "padova_nord", fasciaPercepita: "media", tipologiePrevalenti: ["trilocale anni 60-70", "quadrilocale"], domandaStimata: "media", offertaStimata: "alta", sentimentCommerciale: "stabile", rangePrezzoIndicativoEurMq: { min: 1300, max: 2100 }, tempiStimatiVenditaMesi: { min: 4, max: 9 }, noteOperativeInterne: "Forte sensibilità al prezzo, ristrutturato premia.", ultimoAggiornamento: today },
      { nome: "Sacra Famiglia", comune: "Padova", cluster: "padova_nord", fasciaPercepita: "media", tipologiePrevalenti: ["trilocale", "casa singola"], domandaStimata: "media", offertaStimata: "media", sentimentCommerciale: "stabile", rangePrezzoIndicativoEurMq: { min: 1500, max: 2300 }, tempiStimatiVenditaMesi: { min: 4, max: 8 }, noteOperativeInterne: "Quartiere residenziale, target famiglie.", ultimoAggiornamento: today },
      { nome: "Forcellini", comune: "Padova", cluster: "padova_est", fasciaPercepita: "medio-alta", tipologiePrevalenti: ["trilocale", "quadrilocale", "villetta"], domandaStimata: "alta", offertaStimata: "media", sentimentCommerciale: "caldo", rangePrezzoIndicativoEurMq: { min: 2000, max: 2900 }, tempiStimatiVenditaMesi: { min: 3, max: 6 }, noteOperativeInterne: "Zona ben servita, scuole e verde apprezzati.", ultimoAggiornamento: today },
      { nome: "Madonna Pellegrina", comune: "Padova", cluster: "padova_est", fasciaPercepita: "medio-alta", tipologiePrevalenti: ["trilocale", "quadrilocale"], domandaStimata: "media", offertaStimata: "media", sentimentCommerciale: "stabile", rangePrezzoIndicativoEurMq: { min: 1800, max: 2700 }, tempiStimatiVenditaMesi: { min: 3, max: 7 }, noteOperativeInterne: "Residenziale consolidato, target famiglie 35-55.", ultimoAggiornamento: today },
      { nome: "Guizza", comune: "Padova", cluster: "padova_sud", fasciaPercepita: "media", tipologiePrevalenti: ["trilocale", "quadrilocale"], domandaStimata: "media", offertaStimata: "alta", sentimentCommerciale: "stabile", rangePrezzoIndicativoEurMq: { min: 1500, max: 2200 }, tempiStimatiVenditaMesi: { min: 4, max: 8 }, noteOperativeInterne: "Sensibile a prezzo e stato manutenzione.", ultimoAggiornamento: today },
      { nome: "Stanga", comune: "Padova", cluster: "padova_est", fasciaPercepita: "media", tipologiePrevalenti: ["bilocale", "trilocale"], domandaStimata: "media", offertaStimata: "media", sentimentCommerciale: "tiepido", rangePrezzoIndicativoEurMq: { min: 1400, max: 2100 }, tempiStimatiVenditaMesi: { min: 5, max: 9 }, noteOperativeInterne: "Zona mista residenziale-commerciale.", ultimoAggiornamento: today },
      { nome: "Camin", comune: "Padova", cluster: "padova_est", fasciaPercepita: "media", tipologiePrevalenti: ["villetta", "trilocale"], domandaStimata: "media", offertaStimata: "media", sentimentCommerciale: "stabile", rangePrezzoIndicativoEurMq: { min: 1500, max: 2200 }, tempiStimatiVenditaMesi: { min: 4, max: 8 }, noteOperativeInterne: "Vicinanza zona industriale impatta percezione.", ultimoAggiornamento: today },
      { nome: "Chiesanuova", comune: "Padova", cluster: "padova_ovest", fasciaPercepita: "media", tipologiePrevalenti: ["trilocale", "casa a schiera"], domandaStimata: "media", offertaStimata: "media", sentimentCommerciale: "stabile", rangePrezzoIndicativoEurMq: { min: 1500, max: 2200 }, tempiStimatiVenditaMesi: { min: 4, max: 8 }, noteOperativeInterne: "Buon collegamento tangenziale.", ultimoAggiornamento: today },
      { nome: "Albignasego", comune: "Albignasego", cluster: "cintura_sud", fasciaPercepita: "medio-alta", tipologiePrevalenti: ["villetta", "quadrilocale"], domandaStimata: "alta", offertaStimata: "media", sentimentCommerciale: "caldo", rangePrezzoIndicativoEurMq: { min: 1800, max: 2600 }, tempiStimatiVenditaMesi: { min: 3, max: 6 }, noteOperativeInterne: "Cintura residenziale ad alta domanda famiglie.", ultimoAggiornamento: today },
      { nome: "Selvazzano Dentro", comune: "Selvazzano Dentro", cluster: "cintura_ovest", fasciaPercepita: "alta", tipologiePrevalenti: ["villa", "quadrilocale", "villetta"], domandaStimata: "alta", offertaStimata: "media", sentimentCommerciale: "caldo", rangePrezzoIndicativoEurMq: { min: 2000, max: 3000 }, tempiStimatiVenditaMesi: { min: 3, max: 6 }, noteOperativeInterne: "Target medio-alto, ville premium su Caselle.", ultimoAggiornamento: today },
      { nome: "Rubano", comune: "Rubano", cluster: "cintura_ovest", fasciaPercepita: "medio-alta", tipologiePrevalenti: ["villetta", "trilocale"], domandaStimata: "alta", offertaStimata: "media", sentimentCommerciale: "caldo", rangePrezzoIndicativoEurMq: { min: 1900, max: 2700 }, tempiStimatiVenditaMesi: { min: 3, max: 6 }, noteOperativeInterne: "Servizi e scuole apprezzati, domanda costante.", ultimoAggiornamento: today },
      { nome: "Cadoneghe", comune: "Cadoneghe", cluster: "cintura_nord", fasciaPercepita: "media", tipologiePrevalenti: ["villetta", "trilocale"], domandaStimata: "media", offertaStimata: "media", sentimentCommerciale: "stabile", rangePrezzoIndicativoEurMq: { min: 1500, max: 2200 }, tempiStimatiVenditaMesi: { min: 4, max: 8 }, noteOperativeInterne: "Equilibrio tra qualità vita e prezzo.", ultimoAggiornamento: today },
      { nome: "Vigodarzere", comune: "Vigodarzere", cluster: "cintura_nord", fasciaPercepita: "media", tipologiePrevalenti: ["villetta", "casa singola"], domandaStimata: "media", offertaStimata: "media", sentimentCommerciale: "stabile", rangePrezzoIndicativoEurMq: { min: 1500, max: 2200 }, tempiStimatiVenditaMesi: { min: 4, max: 8 }, noteOperativeInterne: "Cintura nord, target famiglie.", ultimoAggiornamento: today },
      { nome: "Noventa Padovana", comune: "Noventa Padovana", cluster: "cintura_est", fasciaPercepita: "medio-alta", tipologiePrevalenti: ["villetta", "trilocale"], domandaStimata: "alta", offertaStimata: "media", sentimentCommerciale: "caldo", rangePrezzoIndicativoEurMq: { min: 1800, max: 2600 }, tempiStimatiVenditaMesi: { min: 3, max: 6 }, noteOperativeInterne: "Forte attrazione per famiglie giovani.", ultimoAggiornamento: today },
      { nome: "Ponte San Nicolo'", comune: "Ponte San Nicolo'", cluster: "cintura_sud", fasciaPercepita: "medio-alta", tipologiePrevalenti: ["villetta", "trilocale"], domandaStimata: "alta", offertaStimata: "media", sentimentCommerciale: "caldo", rangePrezzoIndicativoEurMq: { min: 1700, max: 2500 }, tempiStimatiVenditaMesi: { min: 3, max: 7 }, noteOperativeInterne: "Domanda costante, target famiglie 30-50.", ultimoAggiornamento: today },
      { nome: "Abano Terme", comune: "Abano Terme", cluster: "terme_euganee", fasciaPercepita: "alta", tipologiePrevalenti: ["villa", "trilocale", "investimento turistico"], domandaStimata: "media", offertaStimata: "media", sentimentCommerciale: "stabile", rangePrezzoIndicativoEurMq: { min: 2000, max: 3200 }, tempiStimatiVenditaMesi: { min: 4, max: 9 }, noteOperativeInterne: "Mercato termale, attenzione a stagionalità e ricettivo.", ultimoAggiornamento: today },
      { nome: "Montegrotto Terme", comune: "Montegrotto Terme", cluster: "terme_euganee", fasciaPercepita: "medio-alta", tipologiePrevalenti: ["villa", "trilocale", "investimento turistico"], domandaStimata: "media", offertaStimata: "media", sentimentCommerciale: "stabile", rangePrezzoIndicativoEurMq: { min: 1800, max: 2800 }, tempiStimatiVenditaMesi: { min: 4, max: 9 }, noteOperativeInterne: "Mercato termale, dinamica simile ad Abano.", ultimoAggiornamento: today },
    ],
  },
];

export const VISIBILITA_DATI = {
  interno_core: ["noteOperativeInterne", "fonti_grezze", "payload_tecnici"],
  visibili_agenzia: [
    "nome", "comune", "cluster", "fasciaPercepita", "tipologiePrevalenti",
    "domandaStimata", "offertaStimata", "sentimentCommerciale",
    "rangePrezzoIndicativoEurMq", "tempiStimatiVenditaMesi", "ultimoAggiornamento",
  ],
  presentabili_proprietario: [
    "nome", "comune", "fasciaPercepita", "rangePrezzoIndicativoEurMq", "tempiStimatiVenditaMesi",
  ],
} as const;
