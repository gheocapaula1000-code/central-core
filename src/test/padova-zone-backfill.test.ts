// Pure tests for the retro-active Padova zone backfill logic.
// No network, no Supabase, no external APIs.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  resolvePadovaOmiBatch,
  resolvePadovaOmiSync,
  UNRESOLVED_OMI_CODE,
} from "../../supabase/functions/_shared/padovaOmiResolver.ts";

const MIN_CONF = 0.70;
const STRONG = new Set(["point_in_polygon", "precomputed_omi", "alias"]);

function reasonToMethod(r: string | null | undefined): string {
  const s = (r ?? "").toLowerCase();
  if (s === "point_in_polygon") return "point_in_polygon";
  if (s === "precomputed_omi") return "precomputed_omi";
  if (s === "alias_match") return "alias";
  if (s.startsWith("cap_hint")) return "cap_hint";
  return "unresolved";
}
function mapOmi(code: string, zones: Array<{ slug: string; omi_codes: string[] }>) {
  const c = code.trim().toUpperCase();
  for (const z of zones) if (z.omi_codes.map((x) => x.toUpperCase()).includes(c)) return z.slug;
  return null;
}
const ACTIVE_ZONES = [
  { slug: "arcella", omi_codes: ["C3"] },
  { slug: "centro-storico", omi_codes: ["B1", "B2"] },
  { slug: "sud-voltabarozzo-guizza", omi_codes: ["D3", "D2"] },
];

function classify(res: { omi_zone_code: string | null; omi_zone_confidence: number; omi_zone_reason: string }, comuneKnownNorm: string) {
  const method = reasonToMethod(res.omi_zone_reason);
  const validCode = res.omi_zone_code && res.omi_zone_code !== UNRESOLVED_OMI_CODE ? res.omi_zone_code : null;
  const isPadova = comuneKnownNorm === "padova";
  const isUnknown = comuneKnownNorm === "";
  const canPromote = isUnknown && !!validCode && (method === "point_in_polygon" || method === "precomputed_omi");
  const treatAsPadova = isPadova || canPromote;
  if (!treatAsPadova) return { assigned: null, method: "skipped", commercial: null, comune: comuneKnownNorm || null };
  const strongOk = validCode && STRONG.has(method) && res.omi_zone_confidence >= MIN_CONF;
  const slug = strongOk && validCode ? mapOmi(validCode, ACTIVE_ZONES) : null;
  if (strongOk && slug) return { assigned: validCode, method, commercial: slug, comune: "Padova" };
  return { assigned: null, method: method === "cap_hint" ? "cap_hint" : "unresolved", commercial: null, comune: isPadova ? "Padova" : null };
}

const mockSupa = (zonaByIdx: Record<number, string | null>) => ({
  rpc: async (_name: string, args: Record<string, unknown>) => {
    const lats = args.p_lats as number[];
    return {
      data: lats.map((_, i) => ({ idx: i + 1, zona: zonaByIdx[i] ?? null })),
      error: null,
    };
  },
});

describe("padova zone backfill — resolver priority", () => {
  it("PIP prevale su alias/CAP in conflitto", async () => {
    const supa = mockSupa({ 0: "C3" }); // PIP → Arcella
    const [r] = await resolvePadovaOmiBatch(
      [{ lat: 45.42, lng: 11.88, title: "zona Guizza", cap: "35125", indirizzo: "Padova" }],
      supa,
    );
    expect(r.omi_zone_reason).toBe("point_in_polygon");
    expect(r.omi_zone_code).toBe("C3"); // NON D3 (Guizza) né D3 (35125→D3)
  });

  it("precomputed_omi prevale su tutto (anche con coordinate valide)", async () => {
    const supa = mockSupa({ 0: "C3" });
    const [r] = await resolvePadovaOmiBatch(
      [{ lat: 45.42, lng: 11.88, omi_zone_code: "B1", title: "zona Guizza" }],
      supa,
    );
    expect(r.omi_zone_reason).toBe("precomputed_omi");
    expect(r.omi_zone_code).toBe("B1");
  });

  it("alias univoco senza coordinate → confidence 0.70, assegna zona", async () => {
    const supa = mockSupa({});
    const [r] = await resolvePadovaOmiBatch(
      [{ title: "Bilocale zona Guizza", indirizzo: "Via Guizza, Padova" }],
      supa,
    );
    expect(r.omi_zone_reason).toBe("alias_match");
    expect(r.omi_zone_confidence).toBeGreaterThanOrEqual(0.70);
    const c = classify(r, "padova");
    expect(c.commercial).toBe("sud-voltabarozzo-guizza");
  });

  it("CAP 0.40 (cap_hint) NON assegna commercial_zone_slug", async () => {
    const r = resolvePadovaOmiSync({ cap: "35125" });
    expect(r.omi_zone_reason).toMatch(/^cap_hint/);
    expect(r.omi_zone_confidence).toBeCloseTo(0.4, 2);
    const c = classify(r, "padova");
    expect(c.commercial).toBeNull();
    expect(c.method).toBe("cap_hint");
  });

  it("unresolved → nessuna zona assegnata", async () => {
    const supa = mockSupa({ 0: null });
    const [r] = await resolvePadovaOmiBatch(
      [{ lat: 45.0, lng: 11.0 /* fuori Padova */, title: "n/a" }],
      supa,
    );
    const c = classify(r, "padova");
    expect(c.commercial).toBeNull();
    expect(c.assigned).toBeNull();
  });

  it("Comune sconosciuto: promosso a Padova SOLO via PIP/precomputed", async () => {
    const supa = mockSupa({ 0: "C3" });
    const [pip] = await resolvePadovaOmiBatch(
      [{ lat: 45.425, lng: 11.882 }], supa,
    );
    expect(classify(pip, "").comune).toBe("Padova");

    // Alias solo, senza coords → NO promozione
    const aliasOnly = resolvePadovaOmiSync({ title: "zona Guizza" });
    expect(classify(aliasOnly, "").comune).toBeNull();

    // CAP solo → NO promozione
    const capOnly = resolvePadovaOmiSync({ cap: "35125" });
    expect(classify(capOnly, "").comune).toBeNull();
  });

  it("Comune noto della provincia (es. Selvazzano) NON viene mai zonizzato", () => {
    // Simuliamo: il selector del backfill esclude comune != Padova a monte.
    // Contract: legge il file per confermare l'esclusione.
    const src = readFileSync(
      "supabase/functions/padova-private-leads-zone-backfill/index.ts", "utf8",
    );
    expect(src).toMatch(/skipped_known_province\+\+/);
    expect(src).toMatch(/if \(known && norm !== "padova"\)/);
  });

  it("force=true: cap_hint pregresso viene azzerato (commercial_zone_slug=null)", async () => {
    // Simula record già zonizzato con cap_hint → il nuovo pass con cap_hint deve
    // impostare commercial_zone_slug=null (rimosso).
    const r = resolvePadovaOmiSync({ cap: "35125" });
    const c = classify(r, "padova");
    expect(c.commercial).toBeNull(); // nessuna assegnazione debole
    // contract nel codice:
    const src = readFileSync(
      "supabase/functions/padova-private-leads-zone-backfill/index.ts", "utf8",
    );
    expect(src).toMatch(/cleared_weak_assignments/);
  });

  it("mapping OMI → zona usa esclusivamente zone attive lette dal DB", () => {
    const src = readFileSync(
      "supabase/functions/padova-private-leads-zone-backfill/index.ts", "utf8",
    );
    expect(src).toMatch(/from\("civiko_commercial_zones"\)/);
    expect(src).toMatch(/\.eq\("attiva", true\)/);
  });

  it("nessuna API esterna: no fetch a firecrawl/apify/perplexity/portali", () => {
    const files = [
      "supabase/functions/padova-private-leads-zone-backfill/index.ts",
      "supabase/functions/civiko-private-leads-classify/index.ts",
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/firecrawl\.dev/);
      expect(src).not.toMatch(/perplexity\.ai/);
      expect(src).not.toMatch(/api\.apify\.com/);
      expect(src).not.toMatch(/immobiliare\.it\/\w/);
      expect(src).not.toMatch(/idealista\.it\/\w/);
      expect(src).not.toMatch(/casa\.it\/\w/);
      expect(src).not.toMatch(/subito\.it\/\w/);
    }
  });

  it("classify: confidence < 0.70 non assegna commercial_zone_slug", () => {
    const src = readFileSync(
      "supabase/functions/civiko-private-leads-classify/index.ts", "utf8",
    );
    expect(src).toMatch(/MIN_CONF\s*=\s*0\.70/);
    expect(src).toMatch(/STRONG_METHODS/);
  });
});
