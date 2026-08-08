// Static contract test: civiko-one-signals-feed admin full-city.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyCivikoSingleZoneGate } from "../../supabase/functions/_shared/civikoZoneAccessGate.ts";
import { commercialZoneForQuartiere } from "../../supabase/functions/_shared/civikoCommercialZoneByQuartiere.ts";

const SRC = readFileSync(
  resolve(process.cwd(), "supabase/functions/civiko-one-signals-feed/index.ts"),
  "utf8",
);

const ALL_ZONES = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "nord-est",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
];

describe("civiko-one-signals-feed — admin full-city", () => {
  it("A. isAdmin deriva solo da civiko_is_admin_agency sul workspace verificato", () => {
    expect(SRC).toContain('supabase.rpc("civiko_is_admin_agency", { _agency_id: workspaceId })');
    expect(SRC).toContain("UUID_RE.test(workspaceId)");
  });

  it("A. admin senza zona assegnata ottiene comunque le 8 zone", () => {
    expect(SRC).toContain("if (isAdmin) {");
    for (const s of ALL_ZONES) expect(SRC).toContain(s);
    // il fail-closed NO_ZONE_ASSIGNED vive nel ramo non-admin
    expect(SRC).toMatch(/} else \{[\s\S]{0,200}NO_ZONE_ASSIGNED/);
  });

  it("B. requested_zone non degrada l'admin", () => {
    expect(SRC).toContain("const requestedZone = isAdmin ? undefined : requestedZoneRaw;");
    expect(SRC).toContain("if (!isAdmin) {");
  });

  it("C. nessun privilegio dal client", () => {
    expect(SRC).not.toContain('pickStr("is_admin")');
    expect(SRC).not.toContain('pickStr("role")');
    expect(SRC).not.toContain('pickStr("scope")');
    expect(SRC).not.toMatch(/isAdmin\s*=\s*(body|pickStr|req\.headers)/);
  });

  it("scope/applied_zone_slug/zones_in_scope corretti", () => {
    expect(SRC).toContain('const responseScope = isAdmin ? "admin_full_city" : "commercial_zone_isolated";');
    expect(SRC).toContain("const appliedZoneSlug = isAdmin ? null : assignedSlug;");
    expect(SRC).toContain("const zonesInScope = isAdmin ? [...assignedSlugs] : [...zoneFilter];");
    expect(SRC).toContain("scope: responseScope");
    expect(SRC).toContain("applied_zone_slug: appliedZoneSlug");
    expect(SRC).toContain("zones_in_scope: zonesInScope");
  });

  it("G. item senza zona non viene attribuito a Centro Storico", () => {
    expect(SRC).not.toContain("commercial_zone_slug || assignedSlug");
    expect(SRC).not.toContain("commercial_zone_slug: assignedSlug,\n    }))");
    expect(SRC).not.toContain("actual_commercial_zone_slug");
    expect(SRC).toContain('zoneFilter.includes(it.commercial_zone_slug ?? "")');
  });

  it("H. nessun dato agenzia esposto negli item", () => {
    expect(SRC).not.toMatch(/agency_name:\s*row\./);
    expect(SRC).not.toMatch(/\bphone\b\s*:/);
    expect(SRC).not.toMatch(/\bemail\b\s*:/);
  });

  it("I. cap del feed invariato", () => {
    expect(SRC).toMatch(/MAX_LIMIT|Math\.min\(/);
  });

  it("D/E. gate monozona per i clienti resta invariato", () => {
    expect(applyCivikoSingleZoneGate("civiko", ["nord-arcella"])).toEqual({
      civiko: true, ok: true, slugs: ["nord-arcella"],
    });
    expect(applyCivikoSingleZoneGate("civiko", [])).toEqual({
      civiko: true, ok: false, code: "NO_ZONE_ASSIGNED",
    });
    expect(applyCivikoSingleZoneGate("civiko", ["nord-arcella"], "centro-storico")).toEqual({
      civiko: true, ok: false, code: "ZONE_NOT_ASSIGNED",
    });
  });

  it("Stazione → centro-storico, Fiera → est-brenta, 'Stazione / Fiera' fail-closed", () => {
    expect(commercialZoneForQuartiere("Stazione")).toBe("centro-storico");
    expect(commercialZoneForQuartiere("Fiera")).toBe("est-brenta");
    expect(commercialZoneForQuartiere("Stazione / Fiera")).toBeNull();
  });
});
