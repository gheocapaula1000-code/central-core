import { describe, it, expect } from "vitest";
import { TASK_REGISTRY, PROVIDERS, APP_REGISTRY } from "@/lib/constants";

describe("Registry reality check — hardening", () => {
  it("TASK_REGISTRY does not contain real_estate_deep", () => {
    const tasks = TASK_REGISTRY.map((t) => t.task);
    expect(tasks).not.toContain("real_estate_deep");
  });

  it("all TASK_REGISTRY tasks have non-empty task name", () => {
    for (const entry of TASK_REGISTRY) {
      expect(entry.task).toBeTruthy();
      expect(entry.task.trim().length).toBeGreaterThan(0);
    }
  });

  it("all TASK_REGISTRY tasks have valid type", () => {
    const validTypes = ["web", "generative"];
    for (const entry of TASK_REGISTRY) {
      expect(validTypes).toContain(entry.type);
    }
  });

  it("PROVIDERS use 'configured' status, never 'active'", () => {
    for (const p of PROVIDERS) {
      expect(p.status).toBe("configured");
      // Redundant but explicit: no provider should claim "active"
      const status: string = p.status;
      expect(status).not.toBe("active");
    }
  });

  it("PROVIDERS don't claim hardcoded model versions", () => {
    const _hardcodedModels = ["gpt-4", "gpt-4o", "claude-3.5-sonnet", "sonar-pro"];
    for (const p of PROVIDERS) {
      if (p.model !== "sonar") {
        expect(p.model).toBe("Configurazione runtime");
      }
    }
  });

  it("APP_REGISTRY apps use 'connected' or 'configured' status", () => {
    const validStatuses = ["connected", "configured"];
    for (const app of APP_REGISTRY) {
      expect(validStatuses).toContain(app.status);
    }
  });

  it("no TASK_REGISTRY entry references a non-existent domain", () => {
    const allDomains = APP_REGISTRY.flatMap((a) => a.domains);
    for (const entry of TASK_REGISTRY) {
      for (const domain of entry.domains) {
        expect(allDomains).toContain(domain);
      }
    }
  });
});
