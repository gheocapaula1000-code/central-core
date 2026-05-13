// Opportunità Pilota — Metodo Civiko One (Padova e provincia)
// Dataset interno Core. Demo operativa, nessuna chiamata a provider esterni.
// Campi interni (internal_*, source_*) restano nel Core e non vanno mai esposti alla PWA.

import { TERRITORI_CIVIKO_ONE, type ClusterCommerciale } from "./civiko-one-territori";

export type Temperatura = "caldo" | "tiepido" | "freddo";
export type Priorita = "alta" | "media" | "bassa";
export type StatoDossier = "pronto" | "in_preparazione" | "da_verificare";
export type TimingConsigliato = "entro_24h" | "entro_48h" | "questa_settimana";
export type StatoDato = "demo_operativa" | "da_verificare" | "verificato";
export type TipologiaImmobile =
  | "appartamento"
  | "villetta"
  | "casa_indipendente"
  | "commerciale"
  | "terreno";
export type SensitivityLevel = "basso" | "medio" | "alto";

// Campi visibili alla PWA (commerciali, neutri).
export interface OpportunitaPilotaPublic {
  id: string;
  titoloCommerciale: string;
  territorio: string;
  microzona: string;
  comune: string;
  cluster: ClusterCommerciale;
  tipologiaImmobile: TipologiaImmobile;
  temperatura: Temperatura;
  priorita: Priorita;
  probabilitaIncaricoStimata: number; // 0..100
  valoreStimatoEur: number;
  potenzialeProvvigionaleEur: number;
  finestraUtile: string;
  motivoCommerciale: string;
  prossimaAzione: string;
  statoDossier: StatoDossier;
  timingConsigliato: TimingConsigliato;
  statoDato: StatoDato;
}

// Campi interni Core. Mai esporre alla PWA.
export interface OpportunitaPilotaInternal {
  internal_score: number; // 0..100
  confidence_level: number; // 0..1
  signal_summary_internal: string;
  source_sensitivity_level: SensitivityLevel;
  source_visibility: "internal_only";
  last_checked_at: string;
  created_at: string;
  updated_at: string;
}

export interface OpportunitaPilota extends OpportunitaPilotaPublic {
  _internal: OpportunitaPilotaInternal;
}

export const TIMING_LABEL: Record<TimingConsigliato, string> = {
  entro_24h: "Entro 24 ore",
  entro_48h: "Entro 48 ore",
  questa_settimana: "Questa settimana",
};

export const STATO_DOSSIER_LABEL: Record<StatoDossier, string> = {
  pronto: "Dossier pronto",
  in_preparazione: "In preparazione",
  da_verificare: "Da verificare",
};

export const STATO_DATO_LABEL: Record<StatoDato, string> = {
  demo_operativa: "Demo operativa",
  da_verificare: "Da verificare",
  verificato: "Verificato",
};

const today = "2026-05-13";
const territorioPilota = TERRITORI_CIVIKO_ONE[0];

const baseInternal = (
  score: number,
  confidence: number,
  summary: string,
  sensitivity: SensitivityLevel = "basso",
): OpportunitaPilotaInternal => ({
  internal_score: score,
  confidence_level: confidence,
  signal_summary_internal: summary,
  source_sensitivity_level: sensitivity,
  source_visibility: "internal_only",
  last_checked_at: today,
  created_at: today,
  updated_at: today,
});

export const OPPORTUNITA_PILOTA: OpportunitaPilota[] = [
  {
    id: "opp-pd-001",
    titoloCommerciale: "Appartamento ben posizionato in Centro Storico",
    territorio: territorioPilota.nome,
    microzona: "Centro Storico",
    comune: "Padova",
    cluster: "padova_citta",
    tipologiaImmobile: "appartamento",
    temperatura: "caldo",
    priorita: "alta",
    probabilitaIncaricoStimata: 78,
    valoreStimatoEur: 320000,
    potenzialeProvvigionaleEur: 9600,
    finestraUtile: "Finestra utile aperta",
    motivoCommerciale: "Tipologia richiesta nella microzona, offerta limitata.",
    prossimaAzione: "Contatto preliminare con il proprietario.",
    statoDossier: "pronto",
    timingConsigliato: "entro_24h",
    statoDato: "demo_operativa",
    _internal: baseInternal(78, 0.82, "Indicatori coerenti su microzona ad alta domanda."),
  },
  {
    id: "opp-pd-002",
    titoloCommerciale: "Bilocale interessante zona Portello",
    territorio: territorioPilota.nome,
    microzona: "Portello",
    comune: "Padova",
    cluster: "padova_citta",
    tipologiaImmobile: "appartamento",
    temperatura: "caldo",
    priorita: "alta",
    probabilitaIncaricoStimata: 72,
    valoreStimatoEur: 185000,
    potenzialeProvvigionaleEur: 5550,
    finestraUtile: "Finestra utile aperta",
    motivoCommerciale: "Domanda investitori sostenuta sulla microzona.",
    prossimaAzione: "Preparare valutazione preliminare.",
    statoDossier: "pronto",
    timingConsigliato: "entro_48h",
    statoDato: "demo_operativa",
    _internal: baseInternal(72, 0.78, "Microzona con buona rotazione."),
  },
  {
    id: "opp-pd-003",
    titoloCommerciale: "Villetta in zona residenziale Forcellini",
    territorio: territorioPilota.nome,
    microzona: "Forcellini",
    comune: "Padova",
    cluster: "padova_citta",
    tipologiaImmobile: "villetta",
    temperatura: "tiepido",
    priorita: "media",
    probabilitaIncaricoStimata: 58,
    valoreStimatoEur: 410000,
    potenzialeProvvigionaleEur: 12300,
    finestraUtile: "Momento da monitorare",
    motivoCommerciale: "Posizionamento richiesto da famiglie di zona.",
    prossimaAzione: "Verifica documentale prima del contatto.",
    statoDossier: "in_preparazione",
    timingConsigliato: "questa_settimana",
    statoDato: "da_verificare",
    _internal: baseInternal(58, 0.65, "Segnali medi, da consolidare."),
  },
  {
    id: "opp-pd-004",
    titoloCommerciale: "Trilocale ristrutturato in Arcella",
    territorio: territorioPilota.nome,
    microzona: "Arcella",
    comune: "Padova",
    cluster: "padova_citta",
    tipologiaImmobile: "appartamento",
    temperatura: "tiepido",
    priorita: "media",
    probabilitaIncaricoStimata: 52,
    valoreStimatoEur: 165000,
    potenzialeProvvigionaleEur: 4950,
    finestraUtile: "Momento da monitorare",
    motivoCommerciale: "Microzona sensibile al prezzo, premia immobili pronti.",
    prossimaAzione: "Predisporre confronto di posizionamento.",
    statoDossier: "in_preparazione",
    timingConsigliato: "questa_settimana",
    statoDato: "demo_operativa",
    _internal: baseInternal(52, 0.6, "Indicatori coerenti su domanda media."),
  },
  {
    id: "opp-pd-005",
    titoloCommerciale: "Villa singola a Selvazzano Dentro",
    territorio: territorioPilota.nome,
    microzona: "Selvazzano Dentro",
    comune: "Selvazzano Dentro",
    cluster: "prima_cintura",
    tipologiaImmobile: "villetta",
    temperatura: "caldo",
    priorita: "alta",
    probabilitaIncaricoStimata: 75,
    valoreStimatoEur: 520000,
    potenzialeProvvigionaleEur: 15600,
    finestraUtile: "Finestra utile aperta",
    motivoCommerciale: "Cluster premium con domanda costante.",
    prossimaAzione: "Avviare percorso di valorizzazione.",
    statoDossier: "pronto",
    timingConsigliato: "entro_48h",
    statoDato: "demo_operativa",
    _internal: baseInternal(75, 0.8, "Cluster premium, segnali coerenti."),
  },
  {
    id: "opp-pd-006",
    titoloCommerciale: "Soluzione indipendente ad Albignasego",
    territorio: territorioPilota.nome,
    microzona: "Albignasego",
    comune: "Albignasego",
    cluster: "prima_cintura",
    tipologiaImmobile: "casa_indipendente",
    temperatura: "tiepido",
    priorita: "media",
    probabilitaIncaricoStimata: 60,
    valoreStimatoEur: 340000,
    potenzialeProvvigionaleEur: 10200,
    finestraUtile: "Momento da monitorare",
    motivoCommerciale: "Domanda famiglie in zona ben servita.",
    prossimaAzione: "Aggiornare scheda di zona prima del contatto.",
    statoDossier: "in_preparazione",
    timingConsigliato: "questa_settimana",
    statoDato: "demo_operativa",
    _internal: baseInternal(60, 0.7, "Microzona stabile, finestra interessante."),
  },
  {
    id: "opp-pd-007",
    titoloCommerciale: "Appartamento vista parco a Noventa Padovana",
    territorio: territorioPilota.nome,
    microzona: "Noventa Padovana",
    comune: "Noventa Padovana",
    cluster: "prima_cintura",
    tipologiaImmobile: "appartamento",
    temperatura: "tiepido",
    priorita: "media",
    probabilitaIncaricoStimata: 55,
    valoreStimatoEur: 230000,
    potenzialeProvvigionaleEur: 6900,
    finestraUtile: "Momento da monitorare",
    motivoCommerciale: "Buona qualità di vita percepita, domanda costante.",
    prossimaAzione: "Predisporre dossier preliminare.",
    statoDossier: "da_verificare",
    timingConsigliato: "questa_settimana",
    statoDato: "da_verificare",
    _internal: baseInternal(55, 0.62, "Segnali coerenti, da consolidare."),
  },
  {
    id: "opp-pd-008",
    titoloCommerciale: "Immobile termale ad Abano Terme",
    territorio: territorioPilota.nome,
    microzona: "Abano Terme",
    comune: "Abano Terme",
    cluster: "termali_premium",
    tipologiaImmobile: "appartamento",
    temperatura: "freddo",
    priorita: "bassa",
    probabilitaIncaricoStimata: 35,
    valoreStimatoEur: 210000,
    potenzialeProvvigionaleEur: 6300,
    finestraUtile: "Da osservare nei prossimi mesi",
    motivoCommerciale: "Mercato termale stagionale, attendere finestra utile.",
    prossimaAzione: "Monitorare evoluzione nelle prossime settimane.",
    statoDossier: "da_verificare",
    timingConsigliato: "questa_settimana",
    statoDato: "da_verificare",
    _internal: baseInternal(35, 0.5, "Stagionalità termale, indicatori deboli.", "medio"),
  },
  {
    id: "opp-pd-009",
    titoloCommerciale: "Villa di rappresentanza a Teolo",
    territorio: territorioPilota.nome,
    microzona: "Teolo",
    comune: "Teolo",
    cluster: "termali_premium",
    tipologiaImmobile: "villetta",
    temperatura: "tiepido",
    priorita: "media",
    probabilitaIncaricoStimata: 50,
    valoreStimatoEur: 620000,
    potenzialeProvvigionaleEur: 18600,
    finestraUtile: "Momento da monitorare",
    motivoCommerciale: "Cluster premium, domanda selettiva.",
    prossimaAzione: "Preparare dossier di posizionamento mirato.",
    statoDossier: "in_preparazione",
    timingConsigliato: "questa_settimana",
    statoDato: "demo_operativa",
    _internal: baseInternal(50, 0.6, "Premium con tempi di vendita più lunghi."),
  },
  {
    id: "opp-pd-010",
    titoloCommerciale: "Appartamento centrale a Cittadella",
    territorio: territorioPilota.nome,
    microzona: "Cittadella",
    comune: "Cittadella",
    cluster: "provincia_estendere",
    tipologiaImmobile: "appartamento",
    temperatura: "freddo",
    priorita: "bassa",
    probabilitaIncaricoStimata: 30,
    valoreStimatoEur: 175000,
    potenzialeProvvigionaleEur: 5250,
    finestraUtile: "Da osservare nei prossimi mesi",
    motivoCommerciale: "Area da estendere, segnali ancora limitati.",
    prossimaAzione: "Aggiornare scheda territoriale.",
    statoDossier: "da_verificare",
    timingConsigliato: "questa_settimana",
    statoDato: "da_verificare",
    _internal: baseInternal(30, 0.45, "Area in fase di estensione, dati parziali."),
  },
];

// Proiezione pubblica: rimuove i campi interni prima di qualsiasi esposizione.
export function toPublicOpportunita(o: OpportunitaPilota): OpportunitaPilotaPublic {
  const { _internal: _omit, ...pub } = o;
  return pub;
}

export const ULTIMO_AGGIORNAMENTO_OPPORTUNITA = today;
