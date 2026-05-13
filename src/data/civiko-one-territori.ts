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
export type FasePilota = "fase_1" | "fase_2" | "futura";

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
  fasePilota: FasePilota;
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

export const FASE_LABEL: Record<FasePilota, string> = {
  fase_1: "Fase 1",
  fase_2: "Fase 2",
  futura: "Futura",
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
  fasePilota: FasePilota,
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
  fasePilota,
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
      // A. Padova città — Fase 1
      mz("Centro Storico", "Padova", "padova_citta", "premium", ["appartamenti", "commerciali"], "alta", "media", "favorevole", 4, "attivo", "fase_1", "Tagli piccoli muovono velocemente."),
      mz("Portello", "Padova", "padova_citta", "medio-alta", ["appartamenti"], "alta", "media", "favorevole", 3, "attivo", "fase_1", "Forte componente investitori universitari."),
      mz("Arcella", "Padova", "padova_citta", "media", ["appartamenti"], "media", "alta", "neutro", 2, "attivo", "fase_1", "Sensibile al prezzo, premia ristrutturato."),
      mz("Sacra Famiglia", "Padova", "padova_citta", "media", ["appartamenti", "case_indipendenti"], "media", "media", "neutro", 1, "attivo", "fase_1"),
      mz("Forcellini", "Padova", "padova_citta", "medio-alta", ["appartamenti", "villette"], "alta", "media", "favorevole", 2, "attivo", "fase_1"),
      mz("Guizza", "Padova", "padova_citta", "media", ["appartamenti"], "media", "alta", "neutro", 1, "attivo", "fase_1"),
      mz("Stanga", "Padova", "padova_citta", "media", ["appartamenti", "commerciali"], "media", "media", "debole", 0, "da_completare", "fase_1"),

      // A. Padova città — Fase 2
      mz("Madonna Pellegrina", "Padova", "padova_citta", "medio-alta", ["appartamenti"], "media", "media", "neutro", 1, "attivo", "fase_2"),
      mz("Camin", "Padova", "padova_citta", "media", ["villette", "appartamenti"], "media", "media", "neutro", 0, "da_completare", "fase_2"),
      mz("Chiesanuova", "Padova", "padova_citta", "media", ["appartamenti", "villette"], "media", "media", "neutro", 0, "da_completare", "fase_2"),
      mz("Brusegana", "Padova", "padova_citta", "medio-alta", ["appartamenti", "villette"], "media", "media", "neutro", 0, "da_completare", "fase_2"),

      // A. Padova città — Futura
      mz("Torre", "Padova", "padova_citta", "media", ["appartamenti", "villette"], "da_verificare", "da_verificare", "da_verificare", 0, "da_completare", "futura"),
      mz("Mortise", "Padova", "padova_citta", "media", ["appartamenti", "villette"], "da_verificare", "da_verificare", "da_verificare", 0, "da_completare", "futura"),
      mz("Mandria", "Padova", "padova_citta", "media", ["villette", "appartamenti"], "da_verificare", "da_verificare", "da_verificare", 0, "da_completare", "futura"),
      mz("Voltabarozzo", "Padova", "padova_citta", "media", ["villette", "appartamenti"], "da_verificare", "da_verificare", "da_verificare", 0, "da_completare", "futura"),

      // B. Prima cintura — Fase 1
      mz("Albignasego", "Albignasego", "prima_cintura", "medio-alta", ["villette", "appartamenti"], "alta", "media", "favorevole", 2, "attivo", "fase_1"),
      mz("Selvazzano Dentro", "Selvazzano Dentro", "prima_cintura", "premium", ["villette", "case_indipendenti"], "alta", "media", "favorevole", 2, "attivo", "fase_1"),

      // B. Prima cintura — Fase 2
      mz("Rubano", "Rubano", "prima_cintura", "medio-alta", ["villette", "appartamenti"], "alta", "media", "favorevole", 1, "attivo", "fase_2"),
      mz("Cadoneghe", "Cadoneghe", "prima_cintura", "media", ["villette", "appartamenti"], "media", "media", "neutro", 1, "attivo", "fase_2"),
      mz("Noventa Padovana", "Noventa Padovana", "prima_cintura", "medio-alta", ["villette", "appartamenti"], "alta", "media", "favorevole", 1, "attivo", "fase_2"),
      mz("Ponte San Nicolò", "Ponte San Nicolò", "prima_cintura", "medio-alta", ["villette", "appartamenti"], "alta", "media", "favorevole", 1, "attivo", "fase_2"),
      mz("Vigodarzere", "Vigodarzere", "prima_cintura", "media", ["villette", "case_indipendenti"], "media", "media", "neutro", 0, "da_completare", "fase_2"),
      mz("Vigonza", "Vigonza", "prima_cintura", "media", ["villette", "case_indipendenti"], "media", "media", "neutro", 0, "da_completare", "fase_2"),
      mz("Limena", "Limena", "prima_cintura", "media", ["villette", "appartamenti"], "media", "media", "neutro", 0, "da_completare", "fase_2"),

      // B. Prima cintura — Futura
      mz("Saonara", "Saonara", "prima_cintura", "media", ["villette", "case_indipendenti"], "da_verificare", "da_verificare", "da_verificare", 0, "da_completare", "futura"),

      // C. Termali / premium — Fase 1
      mz("Abano Terme", "Abano Terme", "termali_premium", "turistica", ["appartamenti", "villette", "commerciali"], "media", "media", "neutro", 1, "attivo", "fase_1", "Mercato termale, attenzione a stagionalità."),

      // C. Termali / premium — Fase 2
      mz("Montegrotto Terme", "Montegrotto Terme", "termali_premium", "turistica", ["appartamenti", "villette"], "media", "media", "neutro", 1, "attivo", "fase_2"),
      mz("Teolo", "Teolo", "termali_premium", "premium", ["villette", "case_indipendenti", "terreni"], "media", "media", "neutro", 0, "da_completare", "fase_2"),
      mz("Torreglia", "Torreglia", "termali_premium", "premium", ["villette", "case_indipendenti"], "media", "media", "neutro", 0, "da_completare", "fase_2"),

      // C. Termali / premium — Futura
      mz("Galzignano Terme", "Galzignano Terme", "termali_premium", "turistica", ["villette", "appartamenti"], "da_verificare", "da_verificare", "da_verificare", 0, "futuro", "futura"),

      // D. Provincia da estendere — tutte futura
      mz("Cittadella", "Cittadella", "provincia_estendere", "medio-alta", ["appartamenti", "villette", "commerciali"], "media", "media", "neutro", 0, "futuro", "futura"),
      mz("Camposampiero", "Camposampiero", "provincia_estendere", "media", ["villette", "appartamenti"], "da_verificare", "da_verificare", "da_verificare", 0, "futuro", "futura"),
      mz("Piove di Sacco", "Piove di Sacco", "provincia_estendere", "media", ["villette", "appartamenti"], "media", "media", "neutro", 0, "futuro", "futura"),
      mz("Monselice", "Monselice", "provincia_estendere", "media", ["appartamenti", "villette", "commerciali"], "media", "media", "neutro", 0, "futuro", "futura"),
      mz("Este", "Este", "provincia_estendere", "media", ["appartamenti", "villette"], "media", "media", "neutro", 0, "futuro", "futura"),
      mz("Conselve", "Conselve", "provincia_estendere", "media", ["villette", "case_indipendenti"], "da_verificare", "da_verificare", "da_verificare", 0, "futuro", "futura"),
      mz("Montagnana", "Montagnana", "provincia_estendere", "media", ["appartamenti", "villette"], "da_verificare", "da_verificare", "da_verificare", 0, "futuro", "futura"),
    ],
  },
];

export const VISIBILITA_DATI = {
  interno_core: ["noteOperativeInterne", "fonti_grezze", "payload_tecnici"],
  visibili_agenzia: [
    "nome", "comune", "cluster", "fasciaPercepita", "tipologiePrevalenti",
    "domandaStimata", "offertaStimata", "sentimentCommerciale",
    "opportunitaAttive", "ultimoAggiornamento", "stato", "fasePilota",
  ],
  presentabili_proprietario: ["nome", "comune", "fasciaPercepita"],
} as const;
