// Sintesi Proprietario — Metodo Civiko One
// Versione prudente e presentabile del Dossier Agenzia.
// Nessuna fonte, nessuno score, nessun segnale interno, nessun provider.

import {
  DOSSIER_AGENZIA,
  type DossierAgenzia,
} from "./civiko-one-dossier-agenzia";

export type StatoSintesi = "pronta" | "da_completare";

export interface Introduzione {
  testo: string;
  sottotitolo: string;
}

export interface LetturaZonaProprietario {
  sentiment: string;
  domandaStimata: string;
  tipologieRichieste: string;
  andamentoCommerciale: string;
}

export interface PosizionamentoProprietario {
  rangePrudente: string;
  rangeRealistico: string;
  rangeAmbizioso: string;
  spiegazione: string;
}

export interface StrategiaValorizzazione {
  comePresentare: string;
  elementiDaValorizzare: string[];
  comeEvitareSovrastima: string;
  percheMetodo: string;
}

export interface ProssimiPassi {
  verificaDiretta: string;
  raccoltaInformazioni: string;
  definizionePrezzo: string;
  pianoVendita: string;
  eventualeIncarico: string;
}

export interface Disclaimer {
  testo: string;
}

export interface SintesiProprietario {
  id: string;
  dossierId: string;
  opportunitaId: string;
  // Header pulito
  titolo: string;
  microzona: string;
  comune: string;
  clusterLabel: string;
  tipologiaImmobile: string;
  temperatura: DossierAgenzia["temperatura"];
  priorita: DossierAgenzia["priorita"];
  statoSintesi: StatoSintesi;
  // Sezioni presentabili
  introduzione: Introduzione;
  zona: LetturaZonaProprietario;
  posizionamento: PosizionamentoProprietario;
  valorizzazione: StrategiaValorizzazione;
  prossimiPassi: ProssimiPassi;
  disclaimer: Disclaimer;
}

const STATO_SINTESI_BY_DOSSIER: Record<DossierAgenzia["statoDossier"], StatoSintesi> = {
  pronto: "pronta",
  in_preparazione: "da_completare",
  da_verificare: "da_completare",
};

function buildSintesi(d: DossierAgenzia): SintesiProprietario {
  const statoSintesi = STATO_SINTESI_BY_DOSSIER[d.statoDossier];

  return {
    id: `sintesi-${d.id}`,
    dossierId: d.id,
    opportunitaId: d.opportunitaId,
    titolo: d.titoloOpportunita,
    microzona: d.microzona,
    comune: d.comune,
    clusterLabel: d.clusterLabel,
    tipologiaImmobile: d.tipologiaImmobile,
    temperatura: d.temperatura,
    priorita: d.priorita,
    statoSintesi,
    introduzione: {
      testo:
        "Abbiamo analizzato il comportamento commerciale della zona e il posizionamento delle tipologie simili al suo immobile. " +
        "La valutazione che le presentiamo parte da una lettura ordinata del mercato locale, non da dati personali.",
      sottotitolo:
        "Il valore finale lo conferma sempre il mercato, dopo una verifica diretta dell'immobile e un confronto con il proprietario.",
    },
    zona: {
      sentiment: d.zona.sentiment.replace(/^Sentiment commerciale:\s*/, ""),
      domandaStimata: d.zona.domandaOfferta,
      tipologieRichieste: d.zona.tipologieRichieste,
      andamentoCommerciale:
        "La microzona mostra una dinamica commerciale interessante per le tipologie richieste. " +
        "Prima di qualsiasi valutazione definitiva serve una verifica diretta.",
    },
    posizionamento: {
      rangePrudente: `€ ${d.posizionamento.rangePrudenteEur[0].toLocaleString("it-IT")} – € ${d.posizionamento.rangePrudenteEur[1].toLocaleString("it-IT")}`,
      rangeRealistico: `€ ${d.posizionamento.rangeRealisticoEur[0].toLocaleString("it-IT")} – € ${d.posizionamento.rangeRealisticoEur[1].toLocaleString("it-IT")}`,
      rangeAmbizioso: `€ ${d.posizionamento.rangeAmbiziosoEur[0].toLocaleString("it-IT")} – € ${d.posizionamento.rangeAmbiziosoEur[1].toLocaleString("it-IT")}`,
      spiegazione:
        "Il valore finale dipende dal mercato e dalla verifica diretta. " +
        "Il range realistico è quello più probabile per un posizionamento corretto. " +
        "Il range ambizioso richiede condizioni particolari di presentazione e domanda.",
    },
    valorizzazione: {
      comePresentare:
        "Presentare l'immobile con foto di qualità, descrizione accurata e uno stato di manutenzione chiaro. " +
        "Una buona prima impressione accelera le visite qualificate.",
      elementiDaValorizzare: [
        "Pulizia, ordine e stato di manutenzione generale.",
        "Luce naturale, vista e spazi esterni se presenti.",
        "Dotazioni recenti (impianti, serramenti, infissi).",
        "Posizione rispetto a servizi, verde e mobilità.",
      ],
      comeEvitareSovrastima:
        "Un prezzo iniziale troppo alto riduce le visite nelle prime settimane e indebolisce la trattativa. " +
        "Meglio partire con un range realistico e valorizzare la presentazione.",
      percheMetodo:
        "Il metodo serve a posizionare correttamente l'immobile prima della pubblicazione. " +
        "Pubblicare senza strategia significa affidarsi al caso. Un posizionamento studiato aumenta le probabilità di vendere nel tempo giusto.",
    },
    prossimiPassi: {
      verificaDiretta:
        "Fissare una visita all'immobile per valutare stato, esposizione, luminosità e dettagli che non emergono da una lettura di zona.",
      raccoltaInformazioni:
        "Raccogliere documentazione (planimetria, visure, contratti locazione se applicabili) e conoscere le esigenze del proprietario.",
      definizionePrezzo:
        "Confrontare la lettura di zona con le caratteristiche dell'immobile e definire insieme un range di prezzo condiviso.",
      pianoVendita:
        "Definire canali, tempi e azioni di presentazione: foto professionali, descrizione, eventuale home staging leggero.",
      eventualeIncarico:
        "Dopo aver condiviso lettura zona, posizionamento e piano di valorizzazione, proporre un incarico coerente con le aspettative del proprietario.",
    },
    disclaimer: {
      testo:
        "Le indicazioni sono preliminari e basate su una lettura commerciale della zona. " +
        "La valutazione definitiva richiede sempre verifica diretta dell'immobile, documentazione e confronto con il proprietario.",
    },
  };
}

export const SINTESI_PROPRIETARIO: SintesiProprietario[] = DOSSIER_AGENZIA.map(buildSintesi);

export const SINTESI_ULTIMO_AGGIORNAMENTO = "2026-05-13";

export const STATO_SINTESI_LABEL: Record<StatoSintesi, string> = {
  pronta: "Sintesi pronta",
  da_completare: "Da completare",
};
