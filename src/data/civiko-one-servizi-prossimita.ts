// Servizi di prossimità — Metodo Civiko One
// Dataset interno Core, statico/demo. Nessun provider esterno, nessuno scraping.
// Non esporre fonti grezze o nomi specifici di attività salvo dati verificati.

export type PresenzaServizio =
  | "forte_presenza"
  | "presenza_media"
  | "presenza_limitata"
  | "da_verificare";

export type MaturitaDato = "demo" | "da_verificare" | "verificato";

export type CategoriaServizio =
  | "supermercati"
  | "alimentari_botteghe"
  | "bar"
  | "ristoranti"
  | "pizzerie"
  | "tabacchini"
  | "farmacie"
  | "scuole"
  | "asili"
  | "fermate_bus_tram"
  | "parcheggi"
  | "parchi_aree_verdi"
  | "studi_medici"
  | "banche_sportelli"
  | "poste"
  | "palestre_sport"
  | "servizi_famiglie";

export const CATEGORIA_LABEL: Record<CategoriaServizio, string> = {
  supermercati: "Supermercati",
  alimentari_botteghe: "Alimentari / botteghe",
  bar: "Bar",
  ristoranti: "Ristoranti",
  pizzerie: "Pizzerie",
  tabacchini: "Tabacchini",
  farmacie: "Farmacie",
  scuole: "Scuole",
  asili: "Asili",
  fermate_bus_tram: "Fermate bus / tram",
  parcheggi: "Parcheggi",
  parchi_aree_verdi: "Parchi / aree verdi",
  studi_medici: "Studi medici",
  banche_sportelli: "Banche / sportelli",
  poste: "Poste",
  palestre_sport: "Palestre / sport",
  servizi_famiglie: "Servizi per famiglie",
};

export const PRESENZA_LABEL: Record<PresenzaServizio, string> = {
  forte_presenza: "Forte presenza",
  presenza_media: "Presenza media",
  presenza_limitata: "Presenza limitata",
  da_verificare: "Da verificare",
};

export interface ServiziProssimita {
  microzonaKey: string; // `${comune}-${nome}`
  categorie: Partial<Record<CategoriaServizio, PresenzaServizio>>;
  letturaCommerciale: string;
  argomentiUtiliAgente: string[];
  maturitaDato: MaturitaDato;
}

const ALL_DA_VERIFICARE: Partial<Record<CategoriaServizio, PresenzaServizio>> = {
  supermercati: "da_verificare",
  alimentari_botteghe: "da_verificare",
  bar: "da_verificare",
  ristoranti: "da_verificare",
  pizzerie: "da_verificare",
  tabacchini: "da_verificare",
  farmacie: "da_verificare",
  scuole: "da_verificare",
  asili: "da_verificare",
  fermate_bus_tram: "da_verificare",
  parcheggi: "da_verificare",
  parchi_aree_verdi: "da_verificare",
  studi_medici: "da_verificare",
  banche_sportelli: "da_verificare",
  poste: "da_verificare",
  palestre_sport: "da_verificare",
  servizi_famiglie: "da_verificare",
};

const sp = (
  microzonaKey: string,
  categorie: Partial<Record<CategoriaServizio, PresenzaServizio>>,
  letturaCommerciale: string,
  argomentiUtiliAgente: string[],
  maturitaDato: MaturitaDato = "demo",
): ServiziProssimita => ({
  microzonaKey,
  categorie: { ...ALL_DA_VERIFICARE, ...categorie },
  letturaCommerciale,
  argomentiUtiliAgente,
  maturitaDato,
});

export const SERVIZI_PROSSIMITA: ServiziProssimita[] = [
  // Padova città — zone attive principali
  sp(
    "Padova-Centro Storico",
    {
      supermercati: "presenza_media",
      alimentari_botteghe: "forte_presenza",
      bar: "forte_presenza",
      ristoranti: "forte_presenza",
      pizzerie: "forte_presenza",
      tabacchini: "forte_presenza",
      farmacie: "forte_presenza",
      fermate_bus_tram: "forte_presenza",
      parcheggi: "presenza_limitata",
      parchi_aree_verdi: "presenza_media",
      studi_medici: "presenza_media",
      banche_sportelli: "forte_presenza",
      poste: "presenza_media",
      palestre_sport: "presenza_media",
    },
    "Contesto urbano vivo, adatto a professionisti, coppie e investitori per accessibilità e servizi quotidiani. Parcheggio è il punto delicato.",
    [
      "Tutti i servizi essenziali sono raggiungibili a piedi.",
      "Posizione centrale che sostiene il valore nel tempo.",
      "Conviene verificare con il proprietario la situazione parcheggio prima della visita.",
    ],
  ),
  sp(
    "Padova-Portello",
    {
      supermercati: "presenza_media",
      alimentari_botteghe: "presenza_media",
      bar: "forte_presenza",
      ristoranti: "forte_presenza",
      pizzerie: "presenza_media",
      tabacchini: "presenza_media",
      farmacie: "presenza_media",
      scuole: "presenza_media",
      fermate_bus_tram: "forte_presenza",
      parcheggi: "presenza_limitata",
      parchi_aree_verdi: "presenza_media",
      studi_medici: "presenza_media",
      servizi_famiglie: "presenza_media",
    },
    "Zona giovane e ben servita, interessante per investimento sull'affitto e per professionisti vicini all'università.",
    [
      "Forte domanda di affitto sostenuta dal contesto universitario.",
      "Servizi quotidiani e trasporti facilmente raggiungibili.",
      "Argomento utile per investitori che cercano rotazione locativa.",
    ],
  ),
  sp(
    "Padova-Arcella",
    {
      supermercati: "forte_presenza",
      alimentari_botteghe: "forte_presenza",
      bar: "forte_presenza",
      ristoranti: "presenza_media",
      pizzerie: "presenza_media",
      tabacchini: "forte_presenza",
      farmacie: "presenza_media",
      scuole: "presenza_media",
      asili: "presenza_media",
      fermate_bus_tram: "forte_presenza",
      parcheggi: "presenza_media",
      parchi_aree_verdi: "presenza_limitata",
      studi_medici: "presenza_media",
      banche_sportelli: "presenza_media",
      poste: "presenza_media",
      servizi_famiglie: "presenza_media",
    },
    "Zona popolare ben servita nei bisogni quotidiani. Adatta a famiglie attente al prezzo e a piccoli investitori.",
    [
      "Servizi di base molto presenti e facilmente raggiungibili.",
      "Buona accessibilità ai mezzi pubblici verso il centro.",
      "Il ristrutturato viene premiato dal mercato locale.",
    ],
  ),
  sp(
    "Padova-Sacra Famiglia",
    {
      supermercati: "presenza_media",
      alimentari_botteghe: "presenza_media",
      bar: "presenza_media",
      farmacie: "presenza_media",
      scuole: "presenza_media",
      fermate_bus_tram: "presenza_media",
      parcheggi: "presenza_media",
      parchi_aree_verdi: "presenza_media",
      servizi_famiglie: "presenza_media",
    },
    "Microzona residenziale equilibrata, adatta a famiglie e residenti stabili.",
    [
      "Servizi quotidiani presenti senza eccessi commerciali.",
      "Contesto tranquillo che facilita la vendita a famiglie.",
      "Da confermare in visita la copertura dei trasporti per il singolo indirizzo.",
    ],
  ),
  sp(
    "Padova-Forcellini",
    {
      supermercati: "forte_presenza",
      alimentari_botteghe: "presenza_media",
      bar: "forte_presenza",
      ristoranti: "presenza_media",
      pizzerie: "presenza_media",
      tabacchini: "forte_presenza",
      farmacie: "forte_presenza",
      scuole: "forte_presenza",
      asili: "presenza_media",
      fermate_bus_tram: "forte_presenza",
      parcheggi: "presenza_media",
      parchi_aree_verdi: "presenza_media",
      studi_medici: "presenza_media",
      banche_sportelli: "presenza_media",
      poste: "presenza_media",
      palestre_sport: "presenza_media",
      servizi_famiglie: "forte_presenza",
    },
    "Microzona molto adatta a famiglie per scuole, servizi quotidiani e verde. Una delle zone più equilibrate per qualità della vita.",
    [
      "Tutto raggiungibile a piedi: scuole, supermercati, farmacia, fermate.",
      "Argomento forte per famiglie con figli in età scolare.",
      "Buon mix tra residenzialità tranquilla e servizi urbani.",
    ],
  ),
  sp(
    "Padova-Madonna Pellegrina",
    {
      supermercati: "presenza_media",
      alimentari_botteghe: "presenza_media",
      bar: "presenza_media",
      farmacie: "presenza_media",
      scuole: "presenza_media",
      fermate_bus_tram: "presenza_media",
      parcheggi: "presenza_media",
      parchi_aree_verdi: "presenza_media",
      servizi_famiglie: "presenza_media",
    },
    "Zona residenziale equilibrata, adatta a famiglie e coppie consolidate.",
    [
      "Servizi essenziali ben distribuiti.",
      "Contesto stabile che sostiene il valore nel medio periodo.",
      "Verificare in visita la distanza effettiva dalla fermata di riferimento.",
    ],
  ),
  sp(
    "Padova-Guizza",
    {
      supermercati: "forte_presenza",
      alimentari_botteghe: "presenza_media",
      bar: "presenza_media",
      tabacchini: "presenza_media",
      farmacie: "presenza_media",
      scuole: "presenza_media",
      asili: "presenza_media",
      fermate_bus_tram: "forte_presenza",
      parcheggi: "presenza_media",
      parchi_aree_verdi: "presenza_media",
      servizi_famiglie: "presenza_media",
    },
    "Quartiere ben servito nei bisogni quotidiani, accessibile e adatto a famiglie.",
    [
      "Servizi quotidiani facilmente raggiungibili.",
      "Buona accessibilità ai mezzi pubblici.",
      "Argomento utile per famiglie e residenti stabili.",
    ],
  ),

  // Prima cintura — attivi
  sp(
    "Albignasego-Albignasego",
    {
      supermercati: "forte_presenza",
      alimentari_botteghe: "presenza_media",
      bar: "forte_presenza",
      ristoranti: "presenza_media",
      pizzerie: "presenza_media",
      tabacchini: "forte_presenza",
      farmacie: "forte_presenza",
      scuole: "forte_presenza",
      asili: "presenza_media",
      fermate_bus_tram: "presenza_media",
      parcheggi: "forte_presenza",
      parchi_aree_verdi: "presenza_media",
      studi_medici: "presenza_media",
      banche_sportelli: "presenza_media",
      poste: "presenza_media",
      palestre_sport: "presenza_media",
      servizi_famiglie: "forte_presenza",
    },
    "Comune di prima cintura ben servito, adatto a famiglie che cercano spazio mantenendo servizi.",
    [
      "Servizi completi tipici di un comune autonomo.",
      "Buon equilibrio tra residenzialità e accessibilità a Padova.",
      "Argomento forte per famiglie in cerca di villetta o appartamento ampio.",
    ],
  ),
  sp(
    "Selvazzano Dentro-Selvazzano Dentro",
    {
      supermercati: "presenza_media",
      alimentari_botteghe: "presenza_media",
      bar: "presenza_media",
      ristoranti: "presenza_media",
      tabacchini: "presenza_media",
      farmacie: "presenza_media",
      scuole: "forte_presenza",
      asili: "presenza_media",
      fermate_bus_tram: "presenza_media",
      parcheggi: "forte_presenza",
      parchi_aree_verdi: "forte_presenza",
      studi_medici: "presenza_media",
      banche_sportelli: "presenza_media",
      poste: "presenza_media",
      palestre_sport: "presenza_media",
      servizi_famiglie: "forte_presenza",
    },
    "Contesto residenziale di qualità, adatto a famiglie con esigenze di spazio e verde.",
    [
      "Verde e tranquillità sono leve commerciali concrete.",
      "Servizi alle famiglie ben presenti.",
      "Argomento forte per chi cerca villetta in contesto curato.",
    ],
  ),
  sp(
    "Rubano-Rubano",
    {
      supermercati: "forte_presenza",
      alimentari_botteghe: "presenza_media",
      bar: "presenza_media",
      ristoranti: "presenza_media",
      tabacchini: "presenza_media",
      farmacie: "presenza_media",
      scuole: "presenza_media",
      fermate_bus_tram: "presenza_media",
      parcheggi: "forte_presenza",
      parchi_aree_verdi: "presenza_media",
      banche_sportelli: "presenza_media",
      servizi_famiglie: "presenza_media",
    },
    "Comune ben servito con buon accesso alla tangenziale, adatto a famiglie e professionisti.",
    [
      "Buona accessibilità verso Padova e direttrici principali.",
      "Servizi commerciali ampi nella zona.",
      "Argomento utile per famiglie che lavorano in città.",
    ],
  ),
  sp(
    "Cadoneghe-Cadoneghe",
    {
      supermercati: "presenza_media",
      alimentari_botteghe: "presenza_media",
      bar: "presenza_media",
      farmacie: "presenza_media",
      scuole: "presenza_media",
      fermate_bus_tram: "presenza_media",
      parcheggi: "presenza_media",
      parchi_aree_verdi: "presenza_media",
      servizi_famiglie: "presenza_media",
    },
    "Comune residenziale equilibrato, accessibile e adatto a famiglie.",
    [
      "Servizi quotidiani presenti.",
      "Buon rapporto tra prezzo e qualità del contesto.",
      "Verificare in visita la distanza effettiva dai servizi principali.",
    ],
  ),
  sp(
    "Noventa Padovana-Noventa Padovana",
    {
      supermercati: "forte_presenza",
      bar: "presenza_media",
      ristoranti: "presenza_media",
      farmacie: "presenza_media",
      scuole: "presenza_media",
      fermate_bus_tram: "presenza_media",
      parcheggi: "forte_presenza",
      parchi_aree_verdi: "presenza_media",
      banche_sportelli: "presenza_media",
      servizi_famiglie: "presenza_media",
    },
    "Zona residenziale apprezzata, adatta a famiglie e coppie con buon potere d'acquisto.",
    [
      "Servizi commerciali importanti nella zona.",
      "Buona accessibilità da e verso Padova.",
      "Argomento utile per famiglie in cerca di contesto ordinato.",
    ],
  ),
  sp(
    "Ponte San Nicolò-Ponte San Nicolò",
    {
      supermercati: "presenza_media",
      bar: "presenza_media",
      farmacie: "presenza_media",
      scuole: "presenza_media",
      fermate_bus_tram: "presenza_media",
      parcheggi: "forte_presenza",
      parchi_aree_verdi: "presenza_media",
      servizi_famiglie: "presenza_media",
    },
    "Comune residenziale tranquillo, adatto a famiglie e residenti stabili.",
    [
      "Contesto curato con servizi essenziali presenti.",
      "Buona qualità della vita percepita.",
      "Argomento forte per famiglie in cerca di tranquillità.",
    ],
  ),

  // Termali / premium attivi
  sp(
    "Abano Terme-Abano Terme",
    {
      supermercati: "presenza_media",
      bar: "forte_presenza",
      ristoranti: "forte_presenza",
      pizzerie: "presenza_media",
      tabacchini: "presenza_media",
      farmacie: "forte_presenza",
      fermate_bus_tram: "presenza_media",
      parcheggi: "presenza_media",
      parchi_aree_verdi: "forte_presenza",
      studi_medici: "forte_presenza",
      banche_sportelli: "presenza_media",
      poste: "presenza_media",
      palestre_sport: "presenza_media",
    },
    "Contesto termale con forte componente turistica, adatto a investimento e seconde case.",
    [
      "Servizi sanitari e benessere ben presenti.",
      "Verde e tranquillità sostengono il posizionamento.",
      "Per uso investimento valutare la stagionalità con il proprietario.",
    ],
  ),
  sp(
    "Montegrotto Terme-Montegrotto Terme",
    {
      supermercati: "presenza_media",
      bar: "presenza_media",
      ristoranti: "presenza_media",
      farmacie: "presenza_media",
      fermate_bus_tram: "presenza_media",
      parcheggi: "presenza_media",
      parchi_aree_verdi: "forte_presenza",
      studi_medici: "presenza_media",
    },
    "Contesto termale tranquillo, adatto a residenti stabili e seconde case.",
    [
      "Verde e contesto curato sono leve concrete.",
      "Servizi essenziali presenti nel centro.",
      "Per investimento verificare stagionalità e tipologia di domanda.",
    ],
  ),
];

export function getServiziProssimita(comune: string, nome: string): ServiziProssimita | undefined {
  return SERVIZI_PROSSIMITA.find((s) => s.microzonaKey === `${comune}-${nome}`);
}
