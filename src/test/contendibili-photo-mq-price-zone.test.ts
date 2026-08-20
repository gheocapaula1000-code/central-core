import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const sql = readFileSync(
  resolve(root, "supabase/migrations/20260820120000_contendibili_photo_mq_price_zone_v5.sql"),
  "utf8",
);

function section(from: string, to?: string): string {
  const start = sql.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = to ? sql.indexOf(to, start + from.length) : sql.length;
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

/** Mirrors public.civiko_padova_photo_mq_price_zone_ok — documented dry-run. */
function photoMqPriceZoneOk(input: {
  sharedPhotos: number;
  priceA: number;
  priceB: number;
  mqA: number;
  mqB: number;
  zoneA: string;
  zoneB: string;
  viaA?: string | null;
  viaB?: string | null;
  civicoA?: string | null;
  civicoB?: string | null;
}): boolean {
  const { sharedPhotos, priceA, priceB, mqA, mqB, zoneA, zoneB } = input;
  if (sharedPhotos < 1) return false;
  if (!zoneA || zoneA !== zoneB) return false;
  if (!(priceA > 0) || !(priceB > 0)) return false;
  const pLo = Math.min(priceA, priceB);
  const pHi = Math.max(priceA, priceB);
  if (pHi > pLo * 1.15) return false;
  if (pHi > pLo * 1.1 && sharedPhotos < 2) return false;
  if (!(mqA > 0) || !(mqB > 0)) return false;
  const mLo = Math.min(mqA, mqB);
  const mHi = Math.max(mqA, mqB);
  if (mHi > Math.max(mLo + 5, mLo * 1.05)) return false;
  // via/civico are ignored on purpose — agencies hide them.
  return true;
}

describe("v5 pair helper — listings without address can still match", () => {
  const noAddress = {
    viaA: null,
    viaB: null,
    civicoA: null,
    civicoB: null,
  };

  it("forms a group from shared pHash + compatible mq + compatible price + same zone", () => {
    expect(
      photoMqPriceZoneOk({
        sharedPhotos: 2,
        priceA: 200_000,
        priceB: 210_000,
        mqA: 80,
        mqB: 82,
        zoneA: "centro-storico",
        zoneB: "centro-storico",
        ...noAddress,
      }),
    ).toBe(true);
  });

  it("accepts 1 shared photo when price is within 10%", () => {
    expect(
      photoMqPriceZoneOk({
        sharedPhotos: 1,
        priceA: 200_000,
        priceB: 209_000,
        mqA: 80,
        mqB: 83,
        zoneA: "nord-arcella",
        zoneB: "nord-arcella",
        ...noAddress,
      }),
    ).toBe(true);
  });

  it("rejects different zones even with identical photos and mq/price", () => {
    expect(
      photoMqPriceZoneOk({
        sharedPhotos: 2,
        priceA: 200_000,
        priceB: 210_000,
        mqA: 80,
        mqB: 82,
        zoneA: "centro-storico",
        zoneB: "nord-arcella",
        ...noAddress,
      }),
    ).toBe(false);
  });

  it("rejects incompatible mq even with a civic number present", () => {
    expect(
      photoMqPriceZoneOk({
        sharedPhotos: 2,
        priceA: 200_000,
        priceB: 210_000,
        mqA: 60,
        mqB: 95,
        zoneA: "centro-storico",
        zoneB: "centro-storico",
        viaA: "via roma",
        viaB: "via roma",
        civicoA: "12",
        civicoB: "12",
      }),
    ).toBe(false);
  });

  it("rejects zero shared photos even when via+civico match (geo-text retired)", () => {
    expect(
      photoMqPriceZoneOk({
        sharedPhotos: 0,
        priceA: 200_000,
        priceB: 210_000,
        mqA: 80,
        mqB: 82,
        zoneA: "centro-storico",
        zoneB: "centro-storico",
        viaA: "via roma",
        viaB: "via roma",
        civicoA: "12",
        civicoB: "12",
      }),
    ).toBe(false);
  });

  it("requires 2 photos in the 10-15% price band", () => {
    const band = {
      priceA: 200_000,
      priceB: 226_000,
      mqA: 80,
      mqB: 82,
      zoneA: "centro-storico",
      zoneB: "centro-storico",
      ...noAddress,
    };
    expect(photoMqPriceZoneOk({ ...band, sharedPhotos: 1 })).toBe(false);
    expect(photoMqPriceZoneOk({ ...band, sharedPhotos: 2 })).toBe(true);
  });
});

describe("migration 20260820120000 — quoted SQL contract", () => {
  it("pairs are keyed by photo evidence + mq + price + zone, not via/civico", () => {
    const pairs = section(
      "CREATE OR REPLACE FUNCTION public.civiko_padova_matcher_v4_pairs()",
      "COMMENT ON FUNCTION public.civiko_padova_matcher_v4_pairs()",
    );
    expect(pairs).toContain("civiko_padova_photo_mq_price_zone_ok");
    expect(pairs).toContain("HAVING max(coalesce(e.shared_photos, 0)) >= 1");
    expect(pairs).toContain("y.czone_slug = x.czone_slug");
    expect(pairs).toContain("'v5-photo-mq-price-zone'");
    expect(pairs).not.toContain("structural_edges");
    expect(pairs).not.toContain("'STRUCTURAL'");
    expect(pairs).not.toContain("(b.x).via_n = (b.y).via_n");
    expect(pairs).not.toContain("(b.x).civico_n = (b.y).civico_n");
    expect(pairs).not.toContain("dist_m <= 40");
    expect(pairs).not.toContain("dist_m <= 30");
  });

  it("group gate requires photos + mq + price + one zone and forbids structural-only", () => {
    const gate = section(
      "CREATE OR REPLACE FUNCTION public.civiko_padova_img_group_gate_ok(",
      "COMMENT ON FUNCTION public.civiko_padova_img_group_gate_ok",
    );
    expect(gate).toContain("AND coalesce(p_n_pairs_photo, 0) > 0");
    expect(gate).toContain("AND p_prezzo_max <= p_prezzo_min * 1.15");
    expect(gate).toContain("AND p_mq_max <= greatest(p_mq_min + 5, p_mq_min * 1.05)");
    expect(gate).toContain("p_n_zone = 1");
    expect(gate).not.toContain("AND p_n_locali = 1");
    expect(gate).not.toMatch(/OR \(\s*coalesce\(p_mq_min/);
  });

  it("recompute no longer requires via/civico and does not publish geo-text", () => {
    expect(sql).toContain("v5: via/civico are not a candidate gate");
    expect(sql).toContain("v5: civico unit-certified does not publish");
    expect(sql).toContain("THEN ''IMAGE_PHASH_V1'' ELSE ''IMAGE_PHASH_V1'' END");
    expect(sql).toContain("OR pc.evidence_kind IN (''UNIT_GEO_TEXT_V4'', ''MIXED_V4'')");
    expect(sql).toContain("OR coalesce(pc.match_version, '''') LIKE ''%geo-unit-text%''");
    expect(sql).toContain("v5-photo-mq-price-zone");
  });

  it("one-shot DELETE replaces the false live 40 instead of keeping the count", () => {
    expect(sql).toMatch(
      /DELETE FROM public\.padova_contendibili\s+WHERE evidence_kind IN \('UNIT_GEO_TEXT_V4', 'MIXED_V4'\)/,
    );
    expect(sql).toContain("OR coalesce(match_version, '') LIKE '%geo-unit-text%'");
    expect(sql).toContain("OR coalesce(match_version, '') = 'v4-unit-certified'");
  });

  it("documents the address-less dry-run fixtures in SQL", () => {
    expect(sql).toContain("ok_senza_indirizzo");
    expect(sql).toContain("ko_zero_foto");
    expect(sql).toContain("PHOTO_ok_senza_locali");
    expect(sql).toContain("STRUCT_senza_foto");
  });
});
