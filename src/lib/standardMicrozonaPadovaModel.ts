// Central Core — Modello standard microzona Padova
// Derivato dal dossier Arcella (normalizeMicrozona → microzona_dossier → publish-microzona-dossier).
//
// Scopo: fornire UN UNICO riferimento tipizzato per future microzone di Padova e provincia,
// senza modificare lo schema DB attuale né la edge function di publish.
//
// Coerenza:
// - i 4 blocchi e i livelli ammessi sono gli stessi usati da `normalizeMicrozona` e
//   validati da `validateMicrozonaDossier`;
// - i campi "core" (microzona_id, versione, stato, 4 blocchi) corrispondono 1:1 alle
//   colonne di `microzona_dossier` e a ciò che `publish-microzona-dossier` restituisce
//   in `data.{microzona_id, versione, stato, blocchi, riepilogo}`;
// - i campi "anagrafici" (nome, comune, provincia) e `riepilogo` sono metadati
//   derivati/aggregati lato Core: NON cambiano lo schema DB.

import type {
  DossierItem,
  LivelloAffidabilita,
  StatoDossier,
} from "@/lib/normalizeMicrozona";

export type { LivelloAffidabilita, StatoDossier, DossierItem };

/** Anagrafica minima di una microzona Padova (per ora: solo "arcella"). */
export interface MicrozonaAnagrafica {
  /** chiave stabile, lowercase, snake/kebab (es. "arcella") */
  microzona_id: string;
  /** nome leggibile (es. "Arcella") */
  nome: string;
  /** comune di riferimento (es. "Padova") */
  comune: string;
  /** sigla provincia (es. "PD") */
  provincia: "PD";
}

/** Riepilogo aggregato — coerente con `buildRiepilogo` di publish-microzona-dossier. */
export interface MicrozonaRiepilogo {
  totale_elementi: number;
  ripartizione: {
    certo: number;
    probabile: number;
    da_testare: number;
  };
}

/** I 4 blocchi standard del dossier. Ogni elemento deve avere `livello`. */
export interface MicrozonaBlocchi {
  servizi_prossimita: DossierItem[];
  segnali_territoriali: DossierItem[];
  opportunita_candidate: DossierItem[];
  asset_osservati: DossierItem[];
}

/**
 * Modello standard microzona Padova.
 * Unione di: anagrafica + payload `microzona_dossier` + riepilogo aggregato.
 */
export interface StandardMicrozonaPadovaModel extends MicrozonaAnagrafica {
  /** Stato interno del dossier (default: "approvata_interna"). */
  stato_interno: StatoDossier;
  /** ISO timestamp dello snapshot (== colonna `versione` di microzona_dossier). */
  data_snapshot: string;
  /** I 4 blocchi standard. */
  blocchi: MicrozonaBlocchi;
  /** Riepilogo aggregato sui livelli (calcolato, non persistito). */
  riepilogo: MicrozonaRiepilogo;
  /** Note brevi interne (max ~280 char, no URL/email/payload). */
  note_interne: string;
}

/** Chiavi canoniche dei 4 blocchi — riusare ovunque servano iterazioni. */
export const MICROZONA_BLOCCHI: ReadonlyArray<keyof MicrozonaBlocchi> = [
  "servizi_prossimita",
  "segnali_territoriali",
  "opportunita_candidate",
  "asset_osservati",
] as const;

/** Livelli di affidabilità ammessi per gli elementi dei blocchi. */
export const MICROZONA_LIVELLI: ReadonlyArray<LivelloAffidabilita> = [
  "certo",
  "probabile",
  "da_testare",
] as const;

/** Stati ammessi per il dossier (allineati a normalizeMicrozona + publish dry-run). */
export const MICROZONA_STATI: ReadonlyArray<StatoDossier> = [
  "approvata_interna",
  "pubblicabile",
  "pubblicata",
] as const;
