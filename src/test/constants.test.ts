import { describe, it, expect } from "vitest";
import { APP_REGISTRY } from "@/lib/constants";

describe("APP_REGISTRY", () => {
  it("contains exactly 3 apps", () => {
    expect(APP_REGISTRY).toHaveLength(3);
  });

  it("contains wyloni, keydraft, sottra", () => {
    const ids = APP_REGISTRY.map((a) => a.id);
    expect(ids).toContain("wyloni");
    expect(ids).toContain("keydraft");
    expect(ids).toContain("sottra");
  });

  it("all ids are unique", () => {
    const ids = APP_REGISTRY.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(["wyloni", "keydraft", "sottra"])("%s has required fields", (id) => {
    const app = APP_REGISTRY.find((a) => a.id === id)!;
    expect(app.id).toBeTruthy();
    expect(app.name).toBeTruthy();
    expect(app.description).toBeTruthy();
    expect(["connected", "configured"]).toContain(app.status);
    expect(app.domains.length).toBeGreaterThan(0);
  });

  it("no description contains the word AI", () => {
    for (const app of APP_REGISTRY) {
      expect(app.description).not.toMatch(/\bAI\b/);
    }
  });

  it("all domains are lowercase without spaces", () => {
    for (const app of APP_REGISTRY) {
      for (const d of app.domains) {
        expect(d).toBe(d.toLowerCase());
        expect(d).not.toContain(" ");
      }
    }
  });
});
