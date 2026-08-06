/**
 * Civiko One collector boundary.  Provider rows are promotable only when the
 * provider payload names the Comune di Padova explicitly.  Province-level
 * searches and nearby municipalities must never be inferred as Padova.
 */
export function isExplicitPadovaMunicipality(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLocaleLowerCase("it-IT") === "padova";
}

export type MunicipalityDisposition = "padova" | "missing" | "out_of_scope";

export function classifyProviderMunicipality(value: unknown): MunicipalityDisposition {
  if (typeof value !== "string" || value.trim() === "") return "missing";
  return isExplicitPadovaMunicipality(value) ? "padova" : "out_of_scope";
}
