// Persist flags for scheduled territorial collectors (ARPAV / CKAN / aste).
// Manual/admin POSTs stay dry-run unless the caller opts in.
// Cron / scheduler / nightly bodies persist unless dryRun is explicit.

export interface PersistFlags {
  dryRun: boolean;
  doImport: boolean;
}

const SCHEDULED_TRIGGER = /cron|scheduler|pg_cron|central-core|job/i;

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

export function resolveScheduledPersist(body: unknown): PersistFlags {
  const b = asRecord(body);
  if (b.dryRun === true || b.dry_run === true) {
    return { dryRun: true, doImport: false };
  }
  const triggered = String(b.triggered_by ?? b.trigger ?? "");
  const scheduled = SCHEDULED_TRIGGER.test(triggered);
  if (scheduled || b.import === true || b.dryRun === false || b.dry_run === false) {
    return { dryRun: false, doImport: true };
  }
  return { dryRun: true, doImport: false };
}

export function scheduledCollectBody(
  triggeredBy: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    dryRun: false,
    import: true,
    triggered_by: triggeredBy,
    province: ["PD"],
    ...extra,
  };
}
