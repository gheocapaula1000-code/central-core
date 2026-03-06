/**
 * Dati legali centralizzati — Pi.Gi Service di Gheoca Paula.
 * Compilare i valori prima del go-live o settare le env vars VITE_LEGAL_*.
 */
const env = (key: string, fallback: string): string => {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    const val = (import.meta.env as Record<string, string | undefined>)[key];
    if (val && val.trim()) return val.trim();
  }
  return fallback;
};

export const LEGAL_ENTITY = {
  companyName: env("VITE_LEGAL_COMPANY_NAME", "Pi.Gi Service di Gheoca Paula"),
  address: env("VITE_LEGAL_ADDRESS", ""),
  city: env("VITE_LEGAL_CITY", ""),
  province: env("VITE_LEGAL_PROVINCE", ""),
  cap: env("VITE_LEGAL_CAP", ""),
  vatNumber: env("VITE_LEGAL_VAT", ""),
  fiscalCode: env("VITE_LEGAL_CF", ""),
  email: env("VITE_LEGAL_EMAIL", ""),
  pec: env("VITE_LEGAL_PEC", ""),
  phone: env("VITE_LEGAL_PHONE", ""),
} as const;
