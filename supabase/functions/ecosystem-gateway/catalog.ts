// ═══════════════════════════════════════════════════════════════
// EcoSystem Gateway — Wyloni Service Catalog (static, real routes)
// ═══════════════════════════════════════════════════════════════

import type { RecommendedService, ServicePackContext } from "./types.ts";

interface CatalogEntry {
  service_key: string;
  title: string;
  route: string;
  reason: string;
  priority: "high" | "medium" | "low";
}

const CATALOG: CatalogEntry[] = [
  { service_key: "archivio", title: "Archivio Documenti", route: "/archivio", reason: "Utile per archiviare documenti dell'immobile", priority: "high" },
  { service_key: "scanner", title: "Scanner Documenti", route: "/archivio?mode=scan", reason: "Scansiona e digitalizza documenti cartacei", priority: "medium" },
  { service_key: "carica-file", title: "Carica File", route: "/archivio?mode=upload", reason: "Carica file nell'archivio digitale", priority: "medium" },
  { service_key: "bollette", title: "Analisi Bollette", route: "/analisi-bollette", reason: "Analizza bollette utenze dell'immobile", priority: "high" },
  { service_key: "dalla-tua-parte", title: "Dalla Tua Parte", route: "/dalla-tua-parte", reason: "Supporto reclami e contestazioni", priority: "medium" },
  { service_key: "controlla-contratto", title: "Controlla Contratto", route: "/controlla-contratto", reason: "Verifica clausole e condizioni contrattuali", priority: "high" },
  { service_key: "simplex", title: "Simplex", route: "/simplex", reason: "Business plan e pianificazione semplificata", priority: "medium" },
  { service_key: "money", title: "Money", route: "/money", reason: "Informazioni su finanziamenti e agevolazioni", priority: "medium" },
  { service_key: "guida-spid", title: "Guida SPID/CIE", route: "/guida-spid-cie", reason: "Guida per identità digitale", priority: "low" },
  { service_key: "autocertificazioni", title: "Autocertificazioni", route: "/autocertificazioni", reason: "Genera deleghe e autocertificazioni", priority: "medium" },
];

/**
 * Match context flags to recommended Wyloni services.
 * Pure static logic — no external calls.
 */
export function matchServices(ctx: ServicePackContext | undefined): RecommendedService[] {
  if (!ctx) return [];

  const matched: RecommendedService[] = [];
  const add = (key: string) => {
    const entry = CATALOG.find((c) => c.service_key === key);
    if (entry && !matched.some((m) => m.service_key === key)) {
      matched.push({
        ...entry,
        target_app: "wyloni",
        availability: "suggested",
        deeplink: null,
      });
    }
  };

  if (ctx.wantsArchive) { add("archivio"); add("scanner"); add("carica-file"); }
  if (ctx.hasUtilitiesDocs) add("bollette");
  if (ctx.hasContracts) add("controlla-contratto");
  if (ctx.needsComplaintSupport) add("dalla-tua-parte");
  if (ctx.wantsFundingInfo) add("money");
  if (ctx.wantsBusinessPlan) add("simplex");
  if (ctx.needsDelegationDocs) add("autocertificazioni");

  return matched;
}

/** Return all known service keys for contract testing */
export function getAllServiceKeys(): string[] {
  return CATALOG.map((c) => c.service_key);
}

/** Return all known routes for contract testing */
export function getAllRoutes(): string[] {
  return CATALOG.map((c) => c.route);
}
