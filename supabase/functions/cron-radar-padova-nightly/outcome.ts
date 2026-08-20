// Contratto di esito del wrapper cron radar Padova.
// /agent-radar è read-only: le scritture su radar_signals appartengono ad altri
// job (activate-veneto, advanced-veneto, firecrawl microzone, early-offmarket).
// `radarSignalsWritten` resta quindi pura telemetria (0 o null ammessi).
//
// Soft mode: un giorno senza nuovi item NON è un fallimento hard (502).
// Full mode: partial/no-ingestion resta failure.
// Solo provider_failed (HTTP non-2xx / abort) produce sempre 502.

export type RunMode = "soft" | "full";

export function isSameUtcDay(iso: string, now = new Date()): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

export function evaluateRunOutcome(
  summaryOk: boolean,
  radarSignalsWritten: number | null,
  mode: RunMode = "full",
  hasProviderFailure = false,
  sameDaySuccess = false,
): { ok: boolean; error: string | null; radar_signals_written: number | null } {
  // Abort/timeout after a successful same-UTC-day run is retry-safe, not a new outage.
  if (hasProviderFailure && sameDaySuccess) {
    return { ok: true, error: null, radar_signals_written: radarSignalsWritten };
  }
  // Provider down / HTTP error → always hard fail
  if (hasProviderFailure) {
    return { ok: false, error: "radar_downstream_failure", radar_signals_written: radarSignalsWritten };
  }
  // Soft: summary not fully ok (e.g. quiet day, 0 new items) → still green
  if (mode === "soft") {
    return { ok: true, error: null, radar_signals_written: radarSignalsWritten };
  }
  // Full: keep strict contract
  if (!summaryOk) {
    return { ok: false, error: "radar_downstream_failure", radar_signals_written: radarSignalsWritten };
  }
  return { ok: true, error: null, radar_signals_written: radarSignalsWritten };
}
