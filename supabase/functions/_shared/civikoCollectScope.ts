// Civiko — perimetro di correlazione della raccolta 05:45.
//
// La pipeline 05:45 (`collect_pending`) deve lavorare esclusivamente sui run
// provider prodotti dall'esatto ultimo 05:10 (standard o capped). Prima di
// questa correzione la Edge selezionava i primi `max_runs` run globali in
// ordine crescente di `started_at`: bastava un residuo storico non importato
// per affamare i run correnti (starvation) e far fallire il gate.
//
// Nessun costo provider: qui si calcolano solo identificativi già persistiti.

export const COLLECT_SCOPE_PORTALS = ["immobiliare", "idealista", "subito"] as const;
export type CollectScopePortal = typeof COLLECT_SCOPE_PORTALS[number];

export interface CollectScope {
  run_ids: string[];
  by_portal: Record<CollectScopePortal, string[]>;
  since: string | null;
  complete: boolean;
}

function walk(
  raw: unknown,
  out: Array<Record<string, unknown>>,
  depth = 0,
): void {
  if (depth > 6 || raw === null || typeof raw !== "object") return;
  if (Array.isArray(raw)) {
    for (const value of raw.slice(0, 200)) walk(value, out, depth + 1);
    return;
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.run_id === "string" && row.run_id.length > 0) out.push(row);
  for (const value of Object.values(row)) walk(value, out, depth + 1);
}

function portalFamily(raw: unknown): CollectScopePortal | null {
  const value = String(raw ?? "").toLowerCase();
  for (const portal of COLLECT_SCOPE_PORTALS) {
    if (value.startsWith(portal)) return portal;
  }
  return null;
}

/**
 * Estrae dal risultato trusted dell'azione 05:10 gli esatti run_id provider,
 * raggruppati per famiglia di portale. Non inventa nulla: se il risultato non
 * contiene identificativi, lo scope resta vuoto e non completo.
 */
export function extractCollectScope(
  launchResult: unknown,
  since: string | null,
): CollectScope {
  const records: Array<Record<string, unknown>> = [];
  walk(launchResult, records);
  const byPortal = {
    immobiliare: [] as string[],
    idealista: [] as string[],
    subito: [] as string[],
  };
  for (const record of records) {
    const family = portalFamily(record.portal ?? record.portal_family);
    if (!family) continue;
    const runId = String(record.run_id);
    if (!byPortal[family].includes(runId)) byPortal[family].push(runId);
  }
  const runIds = Array.from(new Set(Object.values(byPortal).flat()));
  return {
    run_ids: runIds,
    by_portal: byPortal,
    since: since ?? null,
    complete: COLLECT_SCOPE_PORTALS.every((portal) => byPortal[portal].length > 0),
  };
}

/**
 * Corpo `collect_pending` correlato allo scope. Con run_id espliciti la Edge
 * salta del tutto la selezione globale: i residui storici non possono più
 * affamare il ciclo corrente. Restano comunque quarantinati in modo auditabile.
 */
export function buildCollectPendingBody(
  base: Record<string, unknown>,
  scope: CollectScope,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...base,
    quarantine_stale: true,
    scope_complete: scope.complete,
  };
  if (scope.run_ids.length > 0) body.run_ids = scope.run_ids;
  if (scope.since) body.scope_started_after = scope.since;
  return body;
}
