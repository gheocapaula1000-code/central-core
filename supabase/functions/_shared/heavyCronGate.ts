// Gate per cron pesanti.
//
// In test_intensive: gira ogni notte (heavy_cron_every_n_days=1).
// In saving: gira solo ogni N giorni in base al day-of-year.
//
// Uso (inizio handler di un cron pesante):
//
//   const gate = await shouldRunHeavyCron();
//   if (!gate.run) return new Response(JSON.stringify({skipped:true, ...gate}), ...);

import { getOperationalMode } from "./operationalMode.ts";

export async function shouldRunHeavyCron(): Promise<{
  run: boolean;
  reason: string;
  mode: string;
  doy: number;
  every_n: number;
}> {
  const mode = await getOperationalMode();
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 0)).getTime();
  const doy = Math.floor((Date.now() - start) / 86_400_000);
  const every = Math.max(1, mode.heavy_cron_every_n_days);
  if (every <= 1) {
    return { run: true, reason: "test_intensive_daily", mode: mode.mode, doy, every_n: every };
  }
  if (doy % every === 0) {
    return { run: true, reason: `saving_doy_match_${every}`, mode: mode.mode, doy, every_n: every };
  }
  return { run: false, reason: `saving_doy_skip_${every}`, mode: mode.mode, doy, every_n: every };
}
