// B2B Finder — product registry.
// Profili di prodotto trattabili da B2B Finder.
// Usato per: vertical key (job), product label OpenAI, target clienti/rivenditori/fornitori.

export type ProductKey = "coprimacchia_tnt" | "buste_portaposate_airlaid";
export type B2BSearchMode = "clients" | "resellers" | "suppliers";

export interface ProductProfile {
  key: ProductKey;
  product_name: string;
  settore: string;
  categoria: string;
  vertical: string; // chiave per b2b_search_jobs.vertical
  target_clients: string;
  target_resellers: string;
  target_suppliers: string;
  // Frase prodotto usata nei prompt OpenAI (specifica per modalità).
  openai_product_clients: string;
  openai_product_resellers: string;
  openai_product_suppliers: string;
}

export const PRODUCT_REGISTRY: Record<ProductKey, ProductProfile> = {
  coprimacchia_tnt: {
    key: "coprimacchia_tnt",
    product_name: "Coprimacchia TNT Colorati 100x100 cm",
    settore: "Ristorazione",
    categoria: "Tovagliato Monouso / Mise En Place",
    vertical: "coprimacchia_tnt",
    target_clients:
      "Trattorie, ristoranti pranzo operai, pizzerie, agriturismi, tavole calde, self-service, catering, sale eventi, locali con molti coperti",
    target_resellers:
      "Forniture ristorazione, ingrosso horeca, cash and carry, negozi casalinghi, articoli monouso, packaging alimentare, negozi party/eventi, distributori per bar e ristoranti",
    target_suppliers:
      "Produttori tovagliato monouso TNT, grossisti horeca, importatori TNT, distributori carta e monouso, aziende packaging alimentare",
    openai_product_clients:
      "Coprimacchia TNT Colorati 100x100 cm (tovagliette monouso TNT per coperti ristorazione, sagre, eventi, mense, agriturismi).",
    openai_product_resellers:
      "Coprimacchia TNT Colorati 100x100 cm — cerco RIVENDITORI (ingrossi horeca, cash and carry, negozi casalinghi, party store, packaging alimentare) che possano aggiungere il prodotto a catalogo.",
    openai_product_suppliers:
      "Coprimacchia TNT Colorati 100x100 cm — cerco FORNITORI/PRODUTTORI (produttori TNT, grossisti horeca, importatori, distributori monouso) da cui acquistare il prodotto per rivenderlo.",
  },
  buste_portaposate_airlaid: {
    key: "buste_portaposate_airlaid",
    product_name: "Buste Portaposate Con Tovagliolo Airlaid",
    settore: "Ristorazione",
    categoria: "Tovagliato Monouso / Mise En Place",
    vertical: "buste_portaposate_airlaid",
    target_clients:
      "Trattorie, ristoranti pranzo operai, pizzerie con sala, agriturismi, tavole calde, self-service, catering, sale eventi, locali con molti coperti",
    target_resellers:
      "Forniture ristorazione, ingrosso horeca, cash and carry, negozi casalinghi, articoli monouso, packaging alimentare, negozi party/eventi, distributori per bar e ristoranti",
    target_suppliers:
      "Produttori tovagliato monouso, grossisti horeca, importatori airlaid, distributori carta e monouso, aziende packaging alimentare, fornitori articoli ristorazione",
    openai_product_clients:
      "Buste Portaposate Con Tovagliolo Airlaid (mise en place pronta: busta che contiene posate + tovagliolo airlaid effetto tessuto, per apparecchiatura veloce in trattorie, mense, ristoranti pranzo, catering, agriturismi, sale eventi).",
    openai_product_resellers:
      "Buste Portaposate Con Tovagliolo Airlaid — cerco RIVENDITORI (forniture horeca, cash and carry, ingrosso monouso, negozi casalinghi, party store, packaging alimentare) che possano aggiungere il prodotto a catalogo per la propria clientela ristorazione.",
    openai_product_suppliers:
      "Buste Portaposate Con Tovagliolo Airlaid — cerco FORNITORI/PRODUTTORI (produttori tovagliato monouso, importatori airlaid, grossisti horeca, distributori carta e monouso, packaging alimentare) da cui acquistare il prodotto per rivenderlo.",
  },
};

// Heuristica: detect product key dal nome libero passato da PWA.
export function detectProductKey(productName?: string | null): ProductKey {
  const s = (productName ?? "").toLowerCase();
  if (/airlaid|porta\s*posate|portaposate|buste\s+posate/.test(s)) return "buste_portaposate_airlaid";
  return "coprimacchia_tnt";
}

export function getProductProfile(productName?: string | null): ProductProfile {
  return PRODUCT_REGISTRY[detectProductKey(productName)];
}

export function openaiProductPhrase(profile: ProductProfile, mode: B2BSearchMode): string {
  if (mode === "suppliers") return profile.openai_product_suppliers;
  if (mode === "resellers") return profile.openai_product_resellers;
  return profile.openai_product_clients;
}
