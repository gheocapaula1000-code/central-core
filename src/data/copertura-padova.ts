// Central Core — Copertura Padova
// Modello unificato di copertura territoriale per Padova e provincia.
//
// Scopo:
// - normalizzare in un'unica forma i campi minimi richiesti dal prodotto
//   Metodo Civiko One (microzona_id, nome, comune, provincia, cluster,
//   stato_copertura, maturita_dato, uso_commerciale, note_interne);
// - fornire una sintesi "Copertura Padova" pronta da consumare dalla PWA.
//
// Vincoli:
// - copertura territoriale completa, profondità dati progressiva;
// - nessuna chiamata a provider esterni, nessun dato inventato;
// - i dati sono derivati dal catalogo interno esistente
//   `src/data/civiko-one-territori.ts`, senza alterarne la logica.

import {
  TERRITORI_CIVIKO_ONE,
  CLUSTER_LABEL,
  type ClusterCommerciale,
  type Microzona,
} from "@/data/civiko-one-territori";

export type StatoCopertura =
  | "censita"
  | "attiva"
  | "prioritaria"
  | "in_preparazione";

export type MaturitaDato = "base" | "media" | "alta";

export interface MicrozonaCopertura {
  microzona_id: string;
  nome: string;
  comune: string;
  provincia: "PD";
  cluster_commerciale: ClusterCommerciale;
  cluster_label: string;
  stato_copertura: StatoCopertura;
  maturita_dato: MaturitaDato;
  uso_commerciale_consigliato: string;
  note_interne: string;
}

export interface CoperturaPadovaSintesi {
  totale_microzone_censite: number;
  microzone_attive: number;
  microzone_prioritarie: number;
  microzone_in_preparazione: number;
  microzone_demo_pronte: number;
  microzone_da_arricchire: number;
  copertura_territoriale: "completa" | "parziale";
  profondita_dato: "progressiva";
  nota_lettura: string;
}

export const STATO_COPERTURA_LABEL: Record<StatoCopertura, string> = {
  censita: "Censita",
  attiva: "Attiva",
  prioritaria: "Prioritaria",
  in_preparazione: "In preparazione",
};

export const MATURITA_DATO_LABEL: Record<MaturitaDato, string> = {
  base: "Base",
  media: "Media",
  alta: "Alta",
};

// —— Helpers di derivazione ——

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function deriveStato(m: Microzona): StatoCopertura {
  // Arcella è l'unica microzona pilota completa con snapshot validato.
  if (m.comune === "Padova" && m.nome === "Arcella") return "attiva";
  if (m.stato === "attivo" && m.fasePilota === "fase_1") return "prioritaria";
  if (m.stato === "attivo") return "censita";
  return "in_preparazione";
}

function deriveMaturita(m: Microzona, stato: StatoCopertura): MaturitaDato {
  if (stato === "attiva") return "alta";
  if (stato === "prioritaria") return "media";
  if (stato === "censita") return "media";
  return "base";
}

function deriveUsoCommerciale(m: Microzona, stato: StatoCopertura): string {
  if (stato === "attiva") {
    return "Demo completa: dossier validato, utilizzabile in presentazione agenzia.";
  }
  if (stato === "prioritaria") {
    return "Prossima a entrare in demo: lavorabile come secondo dossier dopo il pilota.";
  }
  if (stato === "censita") {
    return "Copertura censita: usabile per posizionamento territoriale, dato da consolidare prima della demo.";
  }
  return "Predisposta come base strutturata: arricchimento dati pianificato in step successivi.";
}

// —— Dataset derivato ——

const TERRITORIO_PD = TERRITORI_CIVIKO_ONE[0];

export const COPERTURA_PADOVA: ReadonlyArray<MicrozonaCopertura> =
  TERRITORIO_PD.microzone.map((m) => {
    const stato = deriveStato(m);
    return {
      microzona_id: `${slugify(m.comune)}__${slugify(m.nome)}`,
      nome: m.nome,
      comune: m.comune,
      provincia: "PD" as const,
      cluster_commerciale: m.cluster,
      cluster_label: CLUSTER_LABEL[m.cluster],
      stato_copertura: stato,
      maturita_dato: deriveMaturita(m, stato),
      uso_commerciale_consigliato: deriveUsoCommerciale(m, stato),
      note_interne:
        m.noteOperativeInterne ??
        "Nessuna nota interna specifica: dato strutturato di base.",
    };
  });

// —— Sintesi "Copertura Padova" ——

export function buildCoperturaPadovaSintesi(): CoperturaPadovaSintesi {
  const tot = COPERTURA_PADOVA.length;
  const attive = COPERTURA_PADOVA.filter((c) => c.stato_copertura === "attiva").length;
  const prioritarie = COPERTURA_PADOVA.filter((c) => c.stato_copertura === "prioritaria").length;
  const inPrep = COPERTURA_PADOVA.filter((c) => c.stato_copertura === "in_preparazione").length;
  const demoPronte = COPERTURA_PADOVA.filter((c) => c.maturita_dato === "alta").length;
  const daArricchire = COPERTURA_PADOVA.filter((c) => c.maturita_dato === "base").length;

  return {
    totale_microzone_censite: tot,
    microzone_attive: attive,
    microzone_prioritarie: prioritarie,
    microzone_in_preparazione: inPrep,
    microzone_demo_pronte: demoPronte,
    microzone_da_arricchire: daArricchire,
    copertura_territoriale: "completa",
    profondita_dato: "progressiva",
    nota_lettura:
      "Copertura territoriale completa su Padova e provincia. La profondità del dato è progressiva: alcune microzone sono già dimostrabili in demo, altre sono presenti come base strutturata pronta per arricchimento successivo.",
  };
}

export const COPERTURA_PADOVA_SINTESI: CoperturaPadovaSintesi = buildCoperturaPadovaSintesi();
