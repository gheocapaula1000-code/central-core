import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * F19 (necrologi) — aggregate-only privacy contract.
 *
 * Verifies via static inspection that:
 *  - F19 is activated as aggregate_only with k-anonymity >= 3 and a 90-day window
 *  - the obituaries_aggregate_padova table enforces both constraints at the DB level
 *    and is service-role-only (no anon/authenticated GRANTs)
 *  - the import path runs through assertAggregateOnly (no person-level fields)
 *    and suppresses buckets under the threshold (never persists them)
 *  - F19 does not feed scoring as a person-level signal (not in SOURCE_WEIGHTS)
 *  - the person-level obituary tables remain locked
 */

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

function loadMigrations(): string {
  const dir = resolve(root, "supabase/migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => read(`supabase/migrations/${f}`))
    .join("\n\n");
}

describe("F19 — registry activation as aggregate_only", () => {
  const sql = loadMigrations();

  it("flips F19 to live + aggregate_only + sensitive_aggregate", () => {
    expect(sql).toMatch(/UPDATE\s+public\.civiko_source_registry[\s\S]*'F19'/);
    expect(sql).toMatch(/aggregate_only/);
    expect(sql).toMatch(/sensitive_aggregate/);
  });

  it("declares a freshness window (90 days)", () => {
    expect(sql).toMatch(/freshness_days\s*=\s*90/);
  });
});

describe("F19 — aggregate table privacy contract (DB-level)", () => {
  const sql = loadMigrations();

  it("creates obituaries_aggregate_padova", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.obituaries_aggregate_padova/);
  });

  it("enforces k-anonymity >= 3 at the DB layer", () => {
    expect(sql).toMatch(/bucket_count\s+INTEGER\s+NOT NULL\s+CHECK\s*\(\s*bucket_count\s*>=\s*3\s*\)/);
  });

  it("constrains the time window to >= 30 days", () => {
    expect(sql).toMatch(/window_days\s+INTEGER\s+NOT NULL\s+CHECK\s*\(\s*window_days\s*>=\s*30\s*\)/);
  });

  it("does not store any person-level column (name, address, url-to-record, cf)", () => {
    // Extract the obituaries_aggregate_padova CREATE TABLE block.
    const m = sql.match(/CREATE TABLE IF NOT EXISTS public\.obituaries_aggregate_padova\s*\(([\s\S]*?)\);/);
    expect(m).not.toBeNull();
    const block = (m![1] ?? "").toLowerCase();
    const banned = [
      "first_name", "last_name", "full_name", "nome", "cognome",
      "deceased", "defunto", "address", "indirizzo",
      "phone", "telefono", "email", "codice_fiscale",
      "obituary_url", "record_url",
    ];
    for (const word of banned) {
      expect(block.includes(word), `column "${word}" must not appear in aggregate table`).toBe(false);
    }
  });

  it("grants no access to anon or authenticated on the aggregate table", () => {
    const grants = sql
      .split(/\n/)
      .filter((l) => /GRANT[\s\S]*obituaries_aggregate_padova/.test(l))
      .join("\n");
    expect(grants).not.toMatch(/\bTO\s+anon\b/i);
    expect(grants).not.toMatch(/\bTO\s+authenticated\b/i);
    expect(grants).toMatch(/\bTO\s+service_role\b/i);
  });

  it("keeps person-level obituary tables locked", () => {
    expect(sql).toMatch(/obituaries_seen_locked/);
    expect(sql).toMatch(/obituaries_sources_locked/);
  });
});

describe("F19 — importer enforces aggregate-only & k-anonymity (app-level)", () => {
  const code = read("supabase/functions/civiko-obituaries-aggregate/index.ts");

  it("is the scheduled F19 collector", () => {
    expect(code).toMatch(/civiko-obituaries-aggregate/);
    expect(code).toMatch(/writeSourceRegistryStatus/);
    expect(code).toMatch(/["']F19["']/);
  });

  it("guards buckets with assertAggregateBucket", () => {
    expect(code).toMatch(/assertAggregateBucket/);
  });

  it("declares k-anonymity minimum of 3 and a default 90-day window", () => {
    expect(code).toMatch(/K_ANONYMITY\s*=\s*3/);
    expect(code).toMatch(/WINDOW_DAYS\s*=\s*90/);
  });

  it("suppresses buckets under threshold (never persists them)", () => {
    expect(code).toMatch(/bucket_count\s*<\s*K_ANONYMITY/);
    expect(code).toMatch(/buckets_below_k/);
  });

  it("does not write any person-level field into the aggregate table payload", () => {
    const body = code.toLowerCase();
    const banned = ["first_name", "last_name", "full_name", "deceased_name", "phone", "email", "codice_fiscale"];
    for (const word of banned) {
      expect(body.includes(word), `importer must not reference "${word}"`).toBe(false);
    }
  });
});

describe("F19 — scoring stays person-level free", () => {
  const scoring = read("supabase/functions/_shared/civikoScoring.ts");

  it("F19 is not a person-level contribution in SOURCE_WEIGHTS", () => {
    // F19 may be added later as a weak aggregate signal; if present it must
    // be tagged confidence: 'low'. Today it is intentionally not wired.
    if (/F19\s*:/.test(scoring)) {
      expect(scoring).toMatch(/F19[\s\S]{0,400}confidence\s*:\s*["']low["']/);
      expect(scoring).toMatch(/F19[\s\S]{0,400}aggregate/i);
    } else {
      expect(scoring).not.toMatch(/\bF19\b/);
    }
  });
});

describe("F19 — appears in source health (connector-status)", () => {
  const code = read("supabase/functions/connector-status/index.ts");
  it("queries the registry so F19 is exposed via source health", () => {
    expect(code).toMatch(/civiko_source_registry/);
  });
});

describe("F19 — aggregate output contract envelope", () => {
  const sql = loadMigrations();
  const fn = read("supabase/functions/civiko-obituaries-aggregate/index.ts");

  it("aggregate table carries contract fields", () => {
    expect(sql).toMatch(/source_code\s+TEXT[^,]*DEFAULT\s+'F19'/i);
    expect(sql).toMatch(/confidence\s+TEXT[^,]*DEFAULT\s+'low'/i);
    expect(sql).toMatch(/last_observed_at\s+TIMESTAMPTZ/i);
    expect(sql).toMatch(/computed_at\s+TIMESTAMPTZ[^,]*DEFAULT\s+now\(\)/i);
    expect(sql).toMatch(/visible_to_pwa\s+BOOLEAN[^,]*DEFAULT\s+false/i);
  });

  it("DB CHECKs lock source_code to F19 and visible_to_pwa to false", () => {
    expect(sql).toMatch(/CHECK\s*\(\s*source_code\s*=\s*'F19'\s*\)/);
    expect(sql).toMatch(/CHECK\s*\(\s*visible_to_pwa\s*=\s*false\s*\)/);
    expect(sql).toMatch(/CHECK\s*\(\s*confidence\s+IN\s*\(\s*'low'\s*,\s*'medium'\s*,\s*'high'\s*\)\s*\)/i);
  });

  it("collector writes the aggregate envelope only (no person-level fields)", () => {
    expect(fn).toMatch(/obituaries_aggregate_padova/);
    const body = fn.toLowerCase();
    const banned = ["first_name", "last_name", "full_name", "deceased_name", "phone", "email", "codice_fiscale"];
    for (const word of banned) {
      expect(body.includes(word), `collector must not persist "${word}"`).toBe(false);
    }
    expect(fn).toMatch(/visible_to_pwa\s*=\s*false/);
    expect(fn).toMatch(/K_ANONYMITY\s*=\s*3/);
  });

  it("collector upsert payload includes the contract envelope keys", () => {
    for (const key of [
      "area_type", "area_code", "window_days", "bucket_count",
      "last_observed_at", "computed_at", "confidence", "visible_to_pwa",
      "source_code",
    ]) {
      expect(fn, `envelope must expose "${key}"`).toMatch(new RegExp(key));
    }
  });
});

describe("F19 — cannot generate person-level or property-level opportunities", () => {
  const root = resolve(__dirname, "../..");
  const opportunityFiles = readdirSync(resolve(root, "supabase/functions/_shared"))
    .filter((f) => /opportun|opportunity/i.test(f))
    .map((f) => read(`supabase/functions/_shared/${f}`));
  const combined = opportunityFiles.join("\n\n");

  it("no opportunity helper consumes obituaries_aggregate_padova or person obituary tables", () => {
    expect(combined).not.toMatch(/obituaries_aggregate_padova/);
    expect(combined).not.toMatch(/\bobituaries_seen\b/);
    expect(combined).not.toMatch(/\bobituaries_sources\b/);
  });

  it("no shared opportunity helper references F19 as a direct trigger", () => {
    // If F19 ever appears, it must be in an aggregate-only / weak-signal context.
    if (/F19/.test(combined)) {
      expect(combined).toMatch(/F19[\s\S]{0,200}(aggregate|weak|low)/i);
    }
  });
});

describe("F19 — registry only marks active because aggregate path exists", () => {
  const sql = loadMigrations();

  it("aggregate table migration precedes (or accompanies) F19 going live", () => {
    // Both must appear; the table creation is the proof-of-path that justifies activation.
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.obituaries_aggregate_padova/);
    expect(sql).toMatch(/UPDATE\s+public\.civiko_source_registry[\s\S]*?aggregate_only[\s\S]*?'F19'/);
  });

  it("freshness window is realistic and documented", () => {
    expect(sql).toMatch(/freshness_days\s*=\s*(7|14|30|60|90)\b/);
  });
});

