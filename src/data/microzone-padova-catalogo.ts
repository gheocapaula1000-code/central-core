// Central Core — Catalogo interno microzone candidate Padova città
// Scopo: definire il perimetro di produzione delle prossime microzone dopo Arcella.
// NON è un seed DB, NON contiene dati di mercato, NON tocca microzona_dossier né la PWA.
// Serve solo come lista ordinata di pianificazione interna.
//
// Coerenza:
// - i campi (microzona_id, nome, comune, provincia) seguono lo stesso naming usato in
//   `StandardMicrozonaPadovaModel` (src/lib/standardMicrozonaPadovaModel.ts);
// - perimetro ristretto a Padova città (no comuni di cintura).

export type StatoCatalogoMicrozona = "pilot_attiva" | "candidata";
export type PrioritaMicrozona = 1 | 2 | 3;

export interface MicrozonaCatalogoItem {
  /** chiave stabile, lowercase, snake/kebab — riusabile come microzona_id nel modello standard */
  microzona_id: string;
  /** nome leggibile (toponimo prudente, non struttura amministrativa ufficiale) */
  nome: string;
  comune: "Padova";
  provincia: "PD";
  stato_catalogo: StatoCatalogoMicrozona;
  /** 1 = prossima da lavorare, 2 = a seguire, 3 = riserva pianificata */
  priorita: PrioritaMicrozona;
  note_interne: string;
}

/**
 * Catalogo iniziale microzone Padova città.
 * Ordinato per priorità (1 → 3), poi per nome.
 */
export const CATALOGO_MICROZONE_PADOVA_CITTA: ReadonlyArray<MicrozonaCatalogoItem> = [
  // —— Pilot attiva ——
  {
    microzona_id: "arcella",
    nome: "Arcella",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "pilot_attiva",
    priorita: 1,
    note_interne: "Microzona pilota completa: dossier validato, snapshot in microzona_dossier, vista PWA /microzone/arcella.",
  },

  // —— Priorità 1: prossime candidate dopo Arcella ——
  {
    microzona_id: "portello",
    nome: "Portello",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 1,
    note_interne: "Forte componente universitaria/investitori; alta liquidità sui tagli piccoli.",
  },
  {
    microzona_id: "forcellini",
    nome: "Forcellini",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 1,
    note_interne: "Quartiere residenziale medio-alto, domanda stabile famiglie.",
  },

  // —— Priorità 2: copertura fitta città ——
  {
    microzona_id: "sacra-famiglia",
    nome: "Sacra Famiglia",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 2,
    note_interne: "Residenziale misto, vicino centro.",
  },
  {
    microzona_id: "madonna-pellegrina",
    nome: "Madonna Pellegrina",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 2,
    note_interne: "Quartiere residenziale storico, medio-alta.",
  },
  {
    microzona_id: "guizza",
    nome: "Guizza",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 2,
    note_interne: "Sensibile al prezzo, buona rotazione tagli medi.",
  },
  {
    microzona_id: "stanga",
    nome: "Stanga",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 2,
    note_interne: "Zona di passaggio, mix residenziale/commerciale.",
  },
  {
    microzona_id: "brusegana",
    nome: "Brusegana",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 2,
    note_interne: "Residenziale tranquillo, mix appartamenti/villette.",
  },
  {
    microzona_id: "chiesanuova",
    nome: "Chiesanuova",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 2,
    note_interne: "Periferia ovest, mix appartamenti/villette.",
  },

  // —— Priorità 3: riserva pianificata ——
  {
    microzona_id: "centro-storico",
    nome: "Centro Storico",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 3,
    note_interne: "Mercato premium e commerciale; richiede dossier dedicato (no estensione meccanica).",
  },
  {
    microzona_id: "camin",
    nome: "Camin",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 3,
    note_interne: "Periferia est, prevalenza villette.",
  },
  {
    microzona_id: "mortise",
    nome: "Mortise",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 3,
    note_interne: "Da verificare segnali commerciali prima del dossier.",
  },
  {
    microzona_id: "torre",
    nome: "Torre",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 3,
    note_interne: "Da verificare segnali commerciali prima del dossier.",
  },
  {
    microzona_id: "mandria",
    nome: "Mandria",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 3,
    note_interne: "Sud città, prevalenza villette.",
  },
  {
    microzona_id: "voltabarozzo",
    nome: "Voltabarozzo",
    comune: "Padova",
    provincia: "PD",
    stato_catalogo: "candidata",
    priorita: 3,
    note_interne: "Sud-est città, mix villette/appartamenti.",
  },
] as const;

/** Helper: prossima microzona candidata da lavorare (priorità 1, esclusa pilot_attiva). */
export function prossimaMicrozonaCandidata(): MicrozonaCatalogoItem | undefined {
  return CATALOGO_MICROZONE_PADOVA_CITTA.find(
    (m) => m.stato_catalogo === "candidata" && m.priorita === 1,
  );
}
