import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const sql = readFileSync(
  resolve(root, "supabase/migrations/20260817150000_contendibili_agency_collapse_photo_required.sql"),
  "utf8",
);

function pairsBody(): string {
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.civiko_padova_matcher_v4_pairs()");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$function$;", start);
  return sql.slice(start, end);
}

function gateBody(): string {
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.civiko_padova_img_group_gate_ok(");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$function$;", start);
  return sql.slice(start, end);
}

/** Mirrors civiko_padova_agency_k3 / collapse_key. */
function agencyK3(agency: string): string {
  return agency
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 3)
    .join("");
}

function collapseKey(agency: string): string {
  const generic = new Set(["immobiliare", "agenzia", "studio", "group", "real", "estate"]);
  const tok = agency
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !generic.has(t));
  return tok[0] ?? agencyK3(agency);
}

function sameOffice(a: string, b: string): boolean {
  const ka = agencyK3(a);
  const kb = agencyK3(b);
  const ca = collapseKey(a);
  const cb = collapseKey(b);
  if (!ka || !kb) return false;
  return ka === kb || ka.startsWith(kb) || kb.startsWith(ka) || (ca !== "" && ca === cb);
}

describe("agency_k3 collapse — same office is one agency", () => {
  it("Gabetti Padova Centro and Gabetti Centro collapse to one office", () => {
    expect(sameOffice("Gabetti Padova Centro", "Gabetti Centro")).toBe(true);
    expect(collapseKey("Gabetti Padova Centro")).toBe("gabetti");
    expect(collapseKey("Gabetti Centro")).toBe("gabetti");
  });

  it("same brand on two portals is still one office", () => {
    expect(sameOffice("Tecnocasa Padova", "Tecnocasa")).toBe(true);
  });

  it("distinct Immobiliare * brands stay two agencies", () => {
    expect(sameOffice("Immobiliare Rossi", "Immobiliare Bianchi")).toBe(false);
  });
});

describe("civiko_padova_matcher_v4_pairs — quoted predicates", () => {
  const pairs = pairsBody();

  it("requires shared pHash and forbids structural-only pairs", () => {
    expect(pairs).toContain("HAVING max(coalesce(e.shared_photos, 0)) >= 1");
    expect(pairs).toContain("AND b.shared_photos >= 1");
    expect(pairs).toContain("AND m.shared_photos >= 1");
    expect(pairs).not.toContain("structural_edges");
    expect(pairs).not.toContain("'STRUCTURAL'");
    expect(pairs).not.toContain("dist_m <= 150");
    expect(pairs).not.toMatch(/OR \(\(b\.x\)\.tipologia IS NOT NULL/);
  });

  it("same house: (via_n AND civico_n) OR dist_m <= 40, plus mq band", () => {
    expect(pairs).toContain("(b.x).via_n = (b.y).via_n");
    expect(pairs).toContain("(b.x).civico_n = (b.y).civico_n");
    expect(pairs).toContain("b.dist_m IS NOT NULL AND b.dist_m <= 40");
    expect(pairs).toContain(
      "<= greatest(least((b.x).mq, (b.y).mq)::numeric + 5,\n                         least((b.x).mq, (b.y).mq)::numeric * 1.05)",
    );
  });

  it("excludes same office after agency_k3 collapse", () => {
    expect(pairs).toContain("NOT public.civiko_padova_agency_same_office(x.agency_raw, y.agency_raw)");
    expect(pairs).toContain("y.agency_key <> x.agency_key");
    expect(sql).toContain("Gabetti Padova Centro");
    expect(sql).toContain("Gabetti Centro");
  });
});

describe("civiko_padova_img_group_gate_ok — photos + collapsed n_agenzie", () => {
  const gate = gateBody();

  it("refuses groups without shared photos and without 2+ agencies", () => {
    expect(gate).toContain("AND p_n_agenzie >= 2");
    expect(gate).toContain("AND coalesce(p_n_pairs_photo, 0) > 0");
    expect(gate).not.toMatch(/coalesce\(p_n_pairs_photo, 0\) > 0\s*\n\s*OR \(/);
  });

  it("still applies mq and locali when n_pairs_photo > 0", () => {
    expect(gate).toContain("AND coalesce(p_mq_min, 0) > 0");
    expect(gate).toContain("AND p_mq_max <= greatest(p_mq_min + 5, p_mq_min * 1.05)");
    expect(gate).toContain("AND p_n_locali = 1");
  });

  it("recompute n_agenzie uses collapse_key, not raw agency_key", () => {
    expect(sql).toContain("civiko_padova_agency_collapse_key(m.agency_raw)");
    expect(sql).toContain("count(DISTINCT m.agency_key) AS n_agenzie");
  });
});
