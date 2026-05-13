// Dossier Agenzia — Metodo Civiko One
// Dataset interno Core. Schede operative collegate alle Opportunità Pilota.
// Nessun dato sensibile, nessuna fonte grezza, nessun nome di provider.

import {
  OPPORTUNITA_PILOTA,
  type OpportunitaPilota,
  type Temperatura,
  type Priorita,
  type StatoDossier,
} from "./civiko-one-opportunita-pilota";
import {
  TERRITORI_CIVIKO_ONE,
  type Microzona,
  type ClusterCommerciale,
  CLUSTER_LABEL,
} from "./civiko-one-territori";

export type UrgenzaCommerciale = "alta" | "media" | "bassa";

export interface SintesiOpportunita {
  perchePotenziale: string;
  perchAgireAdesso: string;
  urgenza: UrgenzaCommerciale;
  obiettivoAgente: string;
}

export interface LetturaZona {
  sentiment: string;
  domandaOfferta: string;
  tipologieRichieste: string;
  fasciaPercepita: string;
  noteCommerciali: string;
}

export interface PosizionamentoImmobile {
  rangePrudenteEur: [number, number];
  rangeRealisticoEur: [number, number];
  rangeAmbiziosoEur: [number, number];
  potenzialeValorizzazione: string;
  rischioSovrastima: string;
}

export interface StrategiaTelefonata {
  obiettivo: string;
  apertura: string;
  domandeConsentite: [string, string, string];
  cosaEvitare: string[];
  comeProporreAppuntamento: string;
}

export interface StrategiaPrimaVisita {
  comePresentarsi: string;
  comeIntrodurreMetodo: string;
  argomentiForti: string[];
  obiezioniProbabili: string[];
  rispostaObiezioni: string[];
  versoEsclusiva: string;
}

export interface ScriptProprietario {
  testo: string;
}

export interface DossierAgenzia {
  id: string;
  opportunitaId: string;
  // Header dal collegamento opportunità
  titoloOpportunita: string;
  microzona: string;
  comune: string;
  cluster: ClusterCommerciale;
  clusterLabel: string;
  tipologiaImmobile: string;
  temperatura: Temperatura;
  priorita: Priorita;
  probabilitaIncaricoStimata: number;
  valoreStimatoEur: number;
  potenzialeProvvigionaleEur: number;
  timingConsigliato: string;
  statoDossier: StatoDossier;
  // Sezioni operative
  sintesi: SintesiOpportunita;
  zona: LetturaZona;
  posizionamento: PosizionamentoImmobile;
  telefonata: StrategiaTelefonata;
  visita: StrategiaPrimaVisita;
  script: ScriptProprietario;
}

const TEMP_LABEL: Record<Temperatura, string> = {
  caldo: "Opportunità calda",
  tiepido: "Opportunità tiepida",
  freddo: "Opportunità da osservare",
};

const URGENZA_BY_TEMP: Record<Temperatura, UrgenzaCommerciale> = {
  caldo: "alta",
  tiepido: "media",
  freddo: "bassa",
};

const TIMING_LABEL: Record<string, string> = {
  entro_24h: "Entro 24 ore",
  entro_48h: "Entro 48 ore",
  questa_settimana: "Questa settimana",
};

function findMicrozona(nome: string): Microzona | undefined {
  for (const t of TERRITORI_CIVIKO_ONE) {
    const m = t.microzone.find((x) => x.nome === nome);
    if (m) return m;
  }
  return undefined;
}

function tipologiaLabel(t: string): string {
  const map: Record<string, string> = {
    appartamento: "appartamenti",
    villetta: "villette",
    casa_indipendente: "case indipendenti",
    commerciale: "immobili commerciali",
    terreno: "terreni",
  };
  return map[t] ?? t;
}

function fasciaLabel(f?: string): string {
  if (!f) return "non disponibile";
  return f.replace("-", " / ");
}

function rangePrice(value: number): {
  prudente: [number, number];
  realistico: [number, number];
  ambizioso: [number, number];
} {
  return {
    prudente: [Math.round(value * 0.9), Math.round(value * 0.97)],
    realistico: [Math.round(value * 0.97), Math.round(value * 1.05)],
    ambizioso: [Math.round(value * 1.05), Math.round(value * 1.12)],
  };
}

function buildDossier(o: OpportunitaPilota): DossierAgenzia {
  const mz = findMicrozona(o.microzona);
  const ranges = rangePrice(o.valoreStimatoEur);
  const tipo = tipologiaLabel(o.tipologiaImmobile);
  const urgenza = URGENZA_BY_TEMP[o.temperatura];

  return {
    id: `dossier-${o.id}`,
    opportunitaId: o.id,
    titoloOpportunita: o.titoloCommerciale,
    microzona: o.microzona,
    comune: o.comune,
    cluster: o.cluster,
    clusterLabel: CLUSTER_LABEL[o.cluster],
    tipologiaImmobile: tipo,
    temperatura: o.temperatura,
    priorita: o.priorita,
    probabilitaIncaricoStimata: o.probabilitaIncaricoStimata,
    valoreStimatoEur: o.valoreStimatoEur,
    potenzialeProvvigionaleEur: o.potenzialeProvvigionaleEur,
    timingConsigliato: TIMING_LABEL[o.timingConsigliato] ?? o.timingConsigliato,
    statoDossier: o.statoDossier,
    sintesi: {
      perchePotenziale: `${TEMP_LABEL[o.temperatura]} su ${o.microzona}: ${o.motivoCommerciale}`,
      perchAgireAdesso: o.finestraUtile,
      urgenza,
      obiettivoAgente:
        urgenza === "alta"
          ? "Fissare un appuntamento di valutazione entro pochi giorni."
          : urgenza === "media"
            ? "Aprire un dialogo con il proprietario e proporre una valutazione."
            : "Mantenere un contatto leggero e monitorare la finestra utile.",
    },
    zona: {
      sentiment: mz ? `Sentiment commerciale: ${mz.sentimentCommerciale}.` : "Sentiment non disponibile.",
      domandaOfferta: mz
        ? `Domanda stimata ${mz.domandaStimata}, offerta stimata ${mz.offertaStimata}.`
        : "Indicazioni di mercato non disponibili.",
      tipologieRichieste: mz
        ? mz.tipologiePrevalenti.join(", ")
        : "non disponibile",
      fasciaPercepita: fasciaLabel(mz?.fasciaPercepita),
      noteCommerciali:
        mz?.noteOperativeInterne ??
        "Microzona da presentare con un linguaggio prudente e orientato al posizionamento.",
    },
    posizionamento: {
      rangePrudenteEur: ranges.prudente,
      rangeRealisticoEur: ranges.realistico,
      rangeAmbiziosoEur: ranges.ambizioso,
      potenzialeValorizzazione:
        "Valutare interventi leggeri di presentazione (home staging, foto, descrizione) prima della pubblicazione.",
      rischioSovrastima:
        "Un prezzo iniziale fuori range realistico riduce le visite nelle prime due settimane e indebolisce la trattativa.",
    },
    telefonata: {
      obiettivo: "Ottenere un appuntamento conoscitivo, non vendere nulla al telefono.",
      apertura: `Buongiorno, la chiamo perché stiamo seguendo con attenzione la zona ${o.microzona} a ${o.comune} e mi farebbe piacere confrontarmi brevemente con lei.`,
      domandeConsentite: [
        "Ha mai pensato di valutare oggi il posizionamento del suo immobile?",
        "Le interessa capire come si sta muovendo la sua microzona?",
        "Preferisce un primo confronto telefonico o un incontro breve in agenzia?",
      ],
      cosaEvitare: [
        "Non dire mai che si hanno informazioni personali sul proprietario.",
        "Non parlare di fonti, dati esterni o segnalazioni.",
        "Non promettere prezzi o tempi certi.",
        "Non insistere se la persona chiede di essere richiamata.",
      ],
      comeProporreAppuntamento:
        "Proponga un incontro breve in agenzia o una valutazione in loco, lasciando al proprietario la scelta del formato.",
    },
    visita: {
      comePresentarsi:
        "Presentarsi come riferimento commerciale della zona, con un metodo di lavoro chiaro e ordinato.",
      comeIntrodurreMetodo:
        "Spiegare che si lavora con un metodo che parte dall'analisi della microzona e dal posizionamento corretto dell'immobile.",
      argomentiForti: [
        `Conoscenza specifica della microzona ${o.microzona}.`,
        `Lettura del cluster ${CLUSTER_LABEL[o.cluster]} e delle dinamiche commerciali.`,
        "Strategia di posizionamento con tre range di prezzo.",
        "Percorso di valorizzazione prima della pubblicazione.",
      ],
      obiezioniProbabili: [
        "Ho già un'altra agenzia.",
        "Voglio provare prima da solo.",
        "Il prezzo che propone mi sembra basso.",
        "Non ho fretta di vendere.",
      ],
      rispostaObiezioni: [
        "Rispetto la scelta, le lascio comunque la lettura della zona così la confronta quando vuole.",
        "Capisco, le propongo una valutazione gratuita che le resta utile in ogni caso.",
        "Il valore reale lo decide il mercato: posso mostrarle come si è mosso negli ultimi mesi.",
        "Anche senza fretta, oggi è il momento giusto per posizionarsi correttamente.",
      ],
      versoEsclusiva:
        "Arrivare alla proposta di esclusiva solo dopo aver condiviso lettura zona, posizionamento e piano di valorizzazione.",
    },
    script: {
      testo: `Buongiorno, le scrivo perché stiamo seguendo da vicino la zona ${o.microzona} a ${o.comune}. Stiamo facendo un'analisi commerciale della microzona e del posizionamento dei ${tipo}. Se le interessa, possiamo condividere una lettura ordinata della zona e una valutazione di posizionamento per il suo immobile. Nessun impegno, solo un confronto utile.`,
    },
  };
}

export const DOSSIER_AGENZIA: DossierAgenzia[] = OPPORTUNITA_PILOTA.map(buildDossier);

export const DOSSIER_ULTIMO_AGGIORNAMENTO = "2026-05-13";

export const STATO_DOSSIER_LABEL: Record<StatoDossier, string> = {
  pronto: "Dossier pronto",
  in_preparazione: "In preparazione",
  da_verificare: "Da verificare",
};

export const TEMPERATURA_LABEL = TEMP_LABEL;
