// ═══════════════════════════════════════════════════════════════
// successioniPotenziali.ts — DISABLED (privacy hardening).
//
// La generazione live di segnali successori a livello di persona/cognome
// derivati da necrologi è VIETATA per uso commerciale.
//
// Vincoli (vedi privacyGuard.ts e sensitiveTurnoverPolicy.ts):
//   • Nessun output con full_name, surname, family_name, deceased_name,
//     heir_name, death_date, obituary_url, indirizzo o civico.
//   • Nessuna istruzione "vai all'indirizzo X" derivata da fonti funebri.
//   • Solo segnali AGGREGATI a livello comune / CAP / microzona /
//     cluster di area sono ammessi, e devono derivare da fonti
//     non personali (ISTAT, OMI, succession_heatmap_cap aggregato).
//
// La funzione esiste solo per compatibilità con i caller esistenti
// e restituisce sempre un array vuoto. Per la pressione successoria
// usare `firecrawl/inheritancePressureExtractor.ts` (aggregati).
// ═══════════════════════════════════════════════════════════════
import type { OpportunitaOffMarket } from "./radarOpportunita.ts";

export async function scrapeSuccessioniPotenziali(
  _municipality: string,
  _province?: string | null,
): Promise<OpportunitaOffMarket[]> {
  // Hardening: disabilitata generazione opportunità da necrologi.
  // Nessuna lettura di obituaries_sources, nessuna scrittura su obituaries_seen,
  // nessun output a livello di persona/famiglia/indirizzo.
  return [];
}
