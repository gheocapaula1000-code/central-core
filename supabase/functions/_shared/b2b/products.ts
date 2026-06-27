// B2B Finder — product registry.
// Profili di prodotto trattabili da B2B Finder.
// Rollback v0.7: solo "Coprimacchia TNT". Modalità: clients | resellers.

export type ProductKey = "coprimacchia_tnt";
export type B2BSearchMode = "clients" | "resellers";

export interface ProductProfile {
  key: ProductKey;
  product_name: string;
  settore: string;
  categoria: string;
  vertical: string; // chiave per b2b_search_jobs.vertical
  target_clients: string;
  target_resellers: string;
  openai_product_clients: string;
  openai_product_resellers: string;
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
    openai_product_clients:
      "Coprimacchia TNT Colorati 100x100 cm (tovagliette monouso TNT per coperti ristorazione, sagre, eventi, mense, agriturismi).",
    openai_product_resellers:
      "Coprimacchia TNT Colorati 100x100 cm — cerco RIVENDITORI (ingrossi horeca, cash and carry, negozi casalinghi, party store, packaging alimentare) che possano aggiungere il prodotto a catalogo.",
  },
};

// Heuristica: detect product key dal nome libero passato da PWA.
// Rollback v0.7: un solo prodotto attivo → ritorna sempre coprimacchia_tnt.
export function detectProductKey(_productName?: string | null): ProductKey {
  return "coprimacchia_tnt";
}

export function getProductProfile(productName?: string | null): ProductProfile {
  return PRODUCT_REGISTRY[detectProductKey(productName)];
}

export function openaiProductPhrase(profile: ProductProfile, mode: B2BSearchMode): string {
  if (mode === "resellers") return profile.openai_product_resellers;
  return profile.openai_product_clients;
}
