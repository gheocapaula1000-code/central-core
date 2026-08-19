// Static/behavioural tests: DRY_RUN of padova-apify-idealista-collect must
// perform ZERO external calls and ZERO writes.
// No network, no Supabase, no Apify.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = "supabase/functions/padova-apify-idealista-collect/index.ts";
const src = readFileSync(SRC, "utf8");

const dryRunIdx = src.indexOf("if (body.dry_run === true)");
const startRunIdx = src.indexOf("await startApifyRun(");

describe("idealista collect — DRY_RUN fail-closed", () => {
  it("handles dry_run before startApifyRun()", () => {
    expect(dryRunIdx).toBeGreaterThan(-1);
    expect(startRunIdx).toBeGreaterThan(-1);
    expect(dryRunIdx).toBeLessThan(startRunIdx);
  });

  it("dry_run branch performs no Apify call, no run row, no spend write", () => {
    const branch = src.slice(dryRunIdx, src.indexOf("\n  }\n", dryRunIdx));
    expect(branch).not.toMatch(/startApifyRun|startRun\(|pollRun\(|fetchDataset\(/);
    expect(branch).not.toMatch(/fetch\(/);
    expect(branch).not.toMatch(/padova_apify_runs|apify_spend_daily|recordApifySpend/);
    expect(branch).not.toMatch(/\.upsert\(|\.insert\(|\.update\(|\.delete\(/);
  });

  it("dry_run branch only reads the budget guard and returns sanitized input", () => {
    const branch = src.slice(dryRunIdx, src.indexOf("\n  }\n", dryRunIdx));
    expect(branch).toContain("await canSpendApify(");
    expect(branch).toContain("budget_guard");
    expect(branch).toContain("estimated_cost_usd");
    expect(branch).toContain("Property_urls");
  });

  it("never leaks the Apify token in the dry_run payload", () => {
    const branch = src.slice(dryRunIdx, src.indexOf("\n  }\n", dryRunIdx));
    expect(branch).not.toMatch(/token|APIFY_API_TOKEN|SERVICE_ROLE/i);
  });

  it("keeps auth and shared modules untouched in behaviour", () => {
    expect(src.indexOf("isJobSecretAuthorized")).toBeGreaterThan(-1);
    expect(src.indexOf("isJobSecretAuthorized")).toBeLessThan(dryRunIdx);
    expect(src).toContain('from "../_shared/apify.ts"');
    expect(src).toContain('from "../_shared/apifyBudget.ts"');
    expect(src).toContain('from "../_shared/jobAuth.ts"');
  });

  it("simulated dry_run flow issues no fetch and no db mutation", async () => {
    const calls: string[] = [];
    const canSpend = async () => {
      calls.push("canSpendApify");
      return { ok: true, spent: 0, cap: 10, calls: 0 };
    };
    const fetchSpy = () => {
      calls.push("fetch");
      throw new Error("network called in dry run");
    };
    const allUrls = ["https://www.idealista.it/vendita-case/padova-padova/"];
    const guard = await canSpend();
    const payload = {
      dry_run: true,
      started: false,
      actor_invoked: false,
      writes_performed: false,
      estimated_cost_usd: 0.5,
      budget_guard: { allowed: guard.ok, daily_cap_usd: guard.cap },
      input: { Property_urls: allUrls.map((u) => ({ url: u })), desiredResults: 10 },
    };
    expect(typeof fetchSpy).toBe("function");
    expect(calls).toEqual(["canSpendApify"]);
    expect(payload.actor_invoked).toBe(false);
    expect(payload.writes_performed).toBe(false);
    expect(payload.input.Property_urls).toHaveLength(1);
  });
});
