// ═══════════════════════════════════════════════════════════════
// EcoSystem Gateway — Normalizers for unified-report
// ═══════════════════════════════════════════════════════════════

interface SectionAvailability {
  available: boolean;
  source?: string;
}

/**
 * Build executive summary from available sections.
 * Does NOT invent content — summarizes what's present.
 */
export function buildExecutiveSummary(
  keydraft: Record<string, unknown> | undefined,
  enrichment: Record<string, unknown> | undefined,
  servicePack: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const sections: string[] = [];
  if (keydraft) sections.push("keydraft");
  if (enrichment) sections.push("enrichment");
  if (servicePack) sections.push("service_pack");

  if (sections.length === 0) return null;

  return {
    sections_included: sections,
    generated_at: new Date().toISOString(),
    note: "Executive summary aggregates available sections without adding invented content",
  };
}

/**
 * Normalize keydraft snapshot into technical sheet.
 */
export function buildTechnicalSheet(keydraft: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!keydraft || Object.keys(keydraft).length === 0) return null;
  return { source: "keydraft", ...keydraft };
}

/**
 * Normalize enrichment into territorial context.
 */
export function buildTerritorialContext(enrichment: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!enrichment || Object.keys(enrichment).length === 0) return null;
  return { source: "sottra", ...enrichment };
}

/**
 * Build availability flags for all sections.
 */
export function buildAvailabilityFlags(
  keydraft: Record<string, unknown> | undefined,
  enrichment: Record<string, unknown> | undefined,
  servicePack: Record<string, unknown> | undefined,
): Record<string, SectionAvailability> {
  return {
    technical_sheet: { available: !!keydraft && Object.keys(keydraft).length > 0, source: "keydraft" },
    territorial_context: { available: !!enrichment && Object.keys(enrichment).length > 0, source: "sottra" },
    service_pack: { available: !!servicePack && Object.keys(servicePack).length > 0, source: "wyloni_catalog" },
  };
}
