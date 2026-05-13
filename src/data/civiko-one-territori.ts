// Territori — Metodo Civiko One
// Dataset interno Core. Non esporre fonti grezze, payload o log.
// Visibilità: dati interni Core. Sottoinsiemi possono essere esposti
// alla PWA agenzie tramite endpoint dedicati (mai direttamente questo file).

export type FasciaPercepita =
  | "popolare"
  | "media"
  | "medio-alta"
  | "premium"
  | "turistica"
  | "commerciale";

export type SentimentCommerciale = "favorevole" | "neutro" | "debole" | "da_verificare";
export type StimaLivello = "alta" | "media" | "bassa" | "da_verificare";
export type StatoMicrozona = "attivo" | "da_completare" | "futuro";

export type ClusterCommerciale =
  | "padova_citta"
  | "prima_cintura"
  | "termali_premium"
  | "provincia_estendere";

export type TipologiaPrevalente =
  | "appartamenti"
  | "villette"
  | "case_indipendenti"
  | "commerciali"
  | "terreni";

export interface Microzona {
  nome: string;
  comune: string;
  cluster: ClusterCommerciale;
  fasciaPercepita: FasciaPercepita;
  tipologiePrevalenti: TipologiaPrevalente[];
  domandaStimata: StimaLivello;
  offertaStimata: StimaLivello;
  sentimentCommerciale: SentimentCommerciale;
  opportunitaAttive: number;
  ultimoAggiornamento: string;
  stato: StatoMicrozona;
  noteOperativeInterne?: string;
}

export interface TerritorioPilota {
  id: string;
  nome: string;
  stato: "attivo" | "preparazione" | "sospeso";
  pwa: string;
  cluster: ClusterCommerciale[];
  microzone: Microzona[];
}

export const CLUSTER_LABEL: Record<ClusterCommerciale, string> = {
  padova_citta: "Padova città",
  prima_cintura: "Prima cintura",
  termali_premium: "Termali / premium",
  provincia_estendere: "Provincia da estendere",
};

const today = "2026-05-13";

// Helper compatto per ridurre rumore
const mz = (
  nome: string,
  comune: string,
  cluster: ClusterCommerciale,
  fascia: FasciaPercepita,
  tipologie: TipologiaPrevalente[],
  domanda: StimaLivello,
  offerta: StimaLivello,
  sentiment: SentimentCommerciale,
  opportunitaAttive: number,
  stato: StatoMicrozona,
  noteOperativeInterne?: string,
): Microzona => ({
  nome,
  comune,
  cluster,
  fasciaPercepita: fascia,
  tipologiePrevalenti: tipologie,
  domandaStimata: domanda,
  offertaStimata: offerta,
  sentimentCommerciale: sentiment,
  opportunitaAttive,
  ultimoAggiornamento: today,
  stato,
  noteOperativeInterne,
});

export const TERRITORI_CIVIKO_ONE: TerritorioPilota[] = [
  {
    id: "padova_e_provincia",
    nome: "Padova e provincia",
    stato: "attivo",
    pwa: "civiko_one",
    cluster: ["padova_citta", "prima_cintura", "termali_premium", "provincia_estendere"],
    microzone: [
      // A. Padova città
      mz("Centro Storico", "Padova", "padova_citta", "premium", ["appartamenti", "commerciali"], "alta", "media", "favorevole", 4, "attivo", "Tagli piccoli muovono velocemente."),
      mz("Portello", "Padova", "padova_citta", "medio-alta", ["appartamenti"], "alta", "media", "favorevole", 3, "attivo", "Forte componente investitori universitari."),
      mz("Arcella", "Padova", "padova_citta", "media", ["appartamenti"], "media", "alta", "neutro", 2, "attivo", "Sensibile al prezzo, premia ristrutturato."),
      mz("Sacra Famiglia", "Padova", "padova_citta", "media", ["appartamenti", "case_indipendenti"], "media", "media", "neutro", 1, "attivo"),
      mz("Forcellini", "Padova", "padova_citta", "medio-alta", ["appartamenti", "villette"], "alta", "media", "favorevole", 2, "attivo"),
      mz("Madonna Pellegrina", "Padova", "padova_citta", "medio-alta", ["appartamenti"], "media", "media", "neutro", 1, "attivo"),
      mz("Guizza", "Padova", "padova_citta", "media", ["appartamenti"], "media", "alta", "neutro", 1, "attivo"),
      mz("Stanga", "Padova", "padova_citta", "media", ["appartamenti", "commerciali"], "media", "media", "debole", 0, "da_completare"),
      mz("Camin", "Padova", "padova_citta", "media", ["villette", "appartamenti"], "media", "media", "neutro", 0, "da_completare"),
      mz("Chiesanuova", "Padova", "padova_citta", "media", ["appartamenti", "villette"], "media", "media", "neutro", 0, "da_completare"),
      mz("Torre", "Padova", "padova_citta", "media", ["appartamenti", "villette"], "da_verificare", "da_verificare", "da_verificare", 0, "da_completare"),
      mz("Mortise", "Padova", "padova_citta", "media", ["appartamenti", "villette"], "da_verificare", "da_verificare", "da_verificare", 0, "da_completare"),
      mz("Brusegana", "Padova", "padova_citta", "medio-alta", ["appartamenti", "villette"], "media", "media", "neutro", 0, "da_completare"),
      mz("Mandria", "Padova", "padova_citta", "media", ["villette", "appartamenti"], "da_verificare", "da_verificare", "da_verificare", 0, "da_completare"),
      mz("Voltabarozzo", "Padova", "padova_citta", "media", ["villette", "appartamenti"], "da_verificare", "da_verificare", "da_verificare", 0, "da_completare"),

      // B. Prima cintura
      mz("Albignasego", "Albignasego", "prima_cintura", "medio-alta", ["villette", "appartamenti"], "alta", "media", "favorevole", 2, "attivo"),
      mz("Selvazzano Dentro", "Selvazzano Dentro", "prima_cintura", "premium", ["villette", "case_indipendenti"], "alta", "media", "favorevole", 2, "attivo"),
      mz("Rubano", "Rubano", "prima_cintura", "medio-alta", ["villette", "appartamenti"], "alta", "media", "favorevole", 1, "attivo"),
      mz("Cadoneghe", "Cadoneghe", "prima_cintura", "media", ["villette", "appartamenti"], "media", "media", "neutro", 1, "attivo"),
      mz("Vigodarzere", "Vigodarzere", "prima_cintura", "media", ["villette", "case_indipendenti"], "media", "media", "neutro", 0, "da_completare"),
      mz("Noventa Padovana", "Noventa Padovana", "prima_cintura", "medio-alta", ["villette", "appartamenti"], "alta", "media", "favorevole", 1, "attivo"),
      mz("Ponte San Nicolò", "Ponte San Nicolò", "prima_cintura", "medio-alta", ["villette", "appartamenti"], "alta", "media", "favorevole", 1, "attivo"),
      mz("Vigonza", "Vigonza", "prima_cintura", "media", ["villette", "case_indipendenti"], "media", "media", "neutro", 0, "da_completare"),
      mz("Limena", "Limena", "prima_cintura", "media", ["villette", "appartamenti"], "media", "media", "neutro", 0, "da_completare"),
      mz("Saonara", "Saonara", "prima_cintura", "media", ["villette", "case_indipendenti"], "da_verificare", "da_verificare", "da_verificare", 0, "da_completare"),

      // C. Termali / premium
      mz("Abano Terme", "Abano Terme", "termali_premium", "turistica", ["appartamenti", "villette", "commerciali"], "media", "media", "neutro", 1, "attivo", "Mercato termale, attenzione a stagionalità."),
      mz("Montegrotto Terme", "Montegrotto Terme", "termali_premium", "turistica", ["appartamenti", "villette"], "media", "media", "neutro", 1, "attivo"),
      mz("Teolo", "Teolo", "termali_premium", "premium", ["villette", "case_indipendenti", "terreni"], "media", "media", "neutro", 0, "da_completare"),
      mz("Torreglia", "Torreglia", "termali_premium", "premium", ["villette", "case_indipendenti"], "media", "media", "neutro", 0, "da_completare"),
      mz("Galzignano Terme", "Galzignano Terme", "termali_premium", "turistica", ["villette", "appartamenti"], "da_verificare", "da_verificare", "da_verificare", 0, "futuro"),

      // D. Provincia da estendere
      mz("Cittadella", "Cittadella", "provincia_estendere", "medio-alta", ["appartamenti", "villette", "commerciali"], "media", "media", "neutro", 0, "futuro"),
      mz("Camposampiero", "Camposampiero", "provincia_estendere", "media", ["villette", "appartamenti"], "da_verificare", "da_verificare", "da_verificare", 0, "futuro"),
      mz("Piove di Sacco", "Piove di Sacco", "provincia_estendere", "media", ["villette", "appartamenti"], "media", "media", "neutro", 0, "futuro"),
      mz("Monselice", "Monselice", "provincia_estendere", "media", ["appartamenti", "villette", "commerciali"], "media", "media", "neutro", 0, "futuro"),
      mz("Este", "Este", "provincia_estendere", "media", ["appartamenti", "villette"], "media", "media", "neutro", 0, "futuro"),
      mz("Conselve", "Conselve", "provincia_estendere", "media", ["villette", "case_indipendenti"], "da_verificare", "da_verificare", "da_verificare", 0, "futuro"),
      mz("Montagnana", "Montagnana", "provincia_estendere", "media", ["appartamenti", "villette"], "da_verificare", "da_verificare", "da_verificare", 0, "futuro"),
    ],
  },
];

export const VISIBILITA_DATI = {
  interno_core: ["noteOperativeInterne", "fonti_grezze", "payload_tecnici"],
  visibili_agenzia: [
    "nome", "comune", "cluster", "fasciaPercepita", "tipologiePrevalenti",
    "domandaStimata", "offertaStimata", "sentimentCommerciale",
    "opportunitaAttive", "ultimoAggiornamento", "stato",
  ],
  presentabili_proprietario: ["nome", "comune", "fasciaPercepita"],
} as const;
