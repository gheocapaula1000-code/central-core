import { describe, expect, it } from "vitest";
import { decideAgentRadarIngestion } from "../../supabase/functions/civiko-radar-veneto/agentRadarIngestionPolicy.ts";

describe("agent-radar soft ingestion decision", () => {
  it("runs ingestion for soft normal-budget Padova cron payloads", () => {
    const d = decideAgentRadarIngestion({
      intent: "soft",
      triggered_by: "cron",
      comuni: ["Padova"],
      budget_mode: "normal",
      run_budget_eur: 7.41,
      hasFirecrawlKey: true,
    });
    expect(d.shouldRunIngestion).toBe(true);
    expect(d.ingestionMode).toBe("soft");
    expect(d.warnings).toEqual([]);
  });

  it("treats mode=incremental as soft ingestion even when intent is omitted", () => {
    const d = decideAgentRadarIngestion({
      mode: "incremental",
      scope: "agency_area",
      triggered_by: "cron",
      comuni: ["Padova"],
      budget_mode: "normal",
      run_budget_eur: 7.41,
      hasFirecrawlKey: true,
    });
    expect(d.shouldRunIngestion).toBe(true);
    expect(d.ingestionMode).toBe("soft");
  });

  it("skips capped budgets with an explicit warning", () => {
    const d = decideAgentRadarIngestion({
      intent: "soft",
      comuni: ["Padova"],
      budget_mode: "capped",
      run_budget_eur: 7.41,
      hasFirecrawlKey: true,
    });
    expect(d.shouldRunIngestion).toBe(false);
    expect(d.skipReason).toBe("budget_capped");
    expect(d.warnings).toContain("soft_ingestion_skipped_budget_capped");
  });

  it("skips missing comuni with an explicit warning", () => {
    const d = decideAgentRadarIngestion({
      intent: "soft",
      comuni: [],
      budget_mode: "normal",
      run_budget_eur: 7.41,
      hasFirecrawlKey: true,
    });
    expect(d.shouldRunIngestion).toBe(false);
    expect(d.skipReason).toBe("no_comuni");
    expect(d.warnings).toContain("soft_ingestion_skipped_no_comuni");
  });

  it("skips missing provider config with an explicit warning before providers can be called", () => {
    const d = decideAgentRadarIngestion({
      intent: "soft",
      comuni: ["Padova"],
      budget_mode: "normal",
      run_budget_eur: 7.41,
      hasFirecrawlKey: false,
    });
    expect(d.shouldRunIngestion).toBe(false);
    expect(d.skipReason).toBe("no_firecrawl_key");
    expect(d.warnings).toContain("soft_ingestion_skipped_no_firecrawl_key");
  });
});
