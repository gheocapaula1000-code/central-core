// Contratto di esito del wrapper cron radar Padova.
// /agent-radar è read-only: le scritture su radar_signals appartengono ad altri
// job (activate-veneto, advanced-veneto, firecrawl microzone, early-offmarket).
// `radarSignalsWritten` resta quindi pura telemetria (0 o null ammessi) e solo
// un fallimento downstream reale produce 502.
export function evaluateRunOutcome(
  summaryOk: boolean,
  radarSignalsWritten: number | null,
): { ok: boolean; error: string | null; radar_signals_written: number | null } {
  if (!summaryOk) {
    return { ok: false, error: "radar_downstream_failure", radar_signals_written: radarSignalsWritten };
  }
  return { ok: true, error: null, radar_signals_written: radarSignalsWritten };
}
