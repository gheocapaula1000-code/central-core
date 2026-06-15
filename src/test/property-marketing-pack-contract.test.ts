/**
 * property-marketing-pack — PWA contract tests.
 *
 * The endpoint is white-label: it MUST expose "Studio Immobile Civiko" and
 * MUST NEVER leak the internal brand "KeyDraft" (or related internal
 * pipeline names) anywhere in the response payload.
 *
 * We don't call the deployed function here — we test contract invariants
 * the PWA depends on, on shaped payloads that mirror what the
 * orchestrator must produce.
 */
import { describe, it, expect } from "vitest";

const STUDIO_NAME = "Studio Immobile Civiko";
const FORBIDDEN_BRAND_RE = /\b(key[\s\-_]*draft|keydraft_engine|ai[-_ ]?core[-_ ]?run)\b/i;

function collectStrings(value: unknown, acc: string[] = []): string[] {
  if (value == null) return acc;
  if (typeof value === "string") { acc.push(value); return acc; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, acc); return acc; }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, acc);
  }
  return acc;
}

function shapedPack() {
  return {
    studio_name: STUDIO_NAME,
    listing_text_long: "Proposta in acquisizione: appartamento luminoso in Padova centro storico.",
    listing_text_short: "Trilocale luminoso, Padova centro.",
    owner_message: "Buongiorno, le proponiamo un incontro per condividere materiali di valorizzazione.",
    social_variants: [
      { channel: "facebook", tone: "professionale", text: "Nuova proposta in Padova centro." },
      { channel: "instagram", tone: "caldo", text: "Tre luminose vetrate su Padova." },
    ],
    highlights: ["Esposizione doppia", "Zona ben servita", "Edificio recente"],
    objection_answers: [
      { objection: "Il prezzo richiesto è alto", answer: "Confrontiamolo con i riferimenti di mercato disponibili." },
    ],
    next_best_action: "Fissare il sopralluogo entro 5 giorni.",
    confidence: "alta",
    warnings: [] as string[],
  };
}

function shapedEnvelope() {
  return {
    ok: true,
    data: shapedPack(),
    warnings: [],
    debug_id: "abc123def456",
  };
}

describe("property-marketing-pack — envelope contract", () => {
  it("envelope has the standard Core V3 keys", () => {
    const env = shapedEnvelope();
    for (const k of ["ok", "data", "warnings", "debug_id"]) expect(env).toHaveProperty(k);
    expect(env.ok).toBe(true);
    expect(typeof env.debug_id).toBe("string");
    expect(Array.isArray(env.warnings)).toBe(true);
  });

  it("data exposes the public studio name", () => {
    const env = shapedEnvelope();
    expect(env.data.studio_name).toBe(STUDIO_NAME);
  });

  it("data has every mandated marketing-pack field", () => {
    const env = shapedEnvelope();
    for (const k of [
      "studio_name", "listing_text_long", "listing_text_short", "owner_message",
      "social_variants", "highlights", "objection_answers",
      "next_best_action", "confidence", "warnings",
    ]) expect(env.data).toHaveProperty(k);
  });

  it("confidence uses one of the 3 allowed labels", () => {
    expect(["alta", "media", "bassa"]).toContain(shapedPack().confidence);
  });

  it("social_variants entries use allowed channels and tones", () => {
    const allowedChannels = ["facebook", "instagram", "linkedin", "whatsapp"];
    const allowedTones = ["professionale", "caldo", "diretto"];
    for (const v of shapedPack().social_variants) {
      expect(allowedChannels).toContain(v.channel);
      expect(allowedTones).toContain(v.tone);
      expect(typeof v.text).toBe("string");
    }
  });

  it("objection_answers entries always have objection + answer", () => {
    for (const oa of shapedPack().objection_answers) {
      expect(typeof oa.objection).toBe("string");
      expect(typeof oa.answer).toBe("string");
    }
  });
});

describe("property-marketing-pack — white-label invariant", () => {
  it("no string in the shaped response leaks the internal brand 'KeyDraft'", () => {
    const env = shapedEnvelope();
    for (const s of collectStrings(env)) {
      expect(s.match(FORBIDDEN_BRAND_RE)).toBeNull();
    }
  });

  it("the white-label scrubber rejects strings that leak internal pipeline names", () => {
    const leaky = [
      "Powered by KeyDraft.",
      "Internal pipeline: keydraft_engine completed.",
      "Routed via ai-core-run for marketing.",
      "key-draft session opened.",
    ];
    for (const s of leaky) expect(s.match(FORBIDDEN_BRAND_RE)).not.toBeNull();
  });

  it("public-safe brand name is the only one to surface", () => {
    expect(STUDIO_NAME).toMatch(/^Studio Immobile Civiko$/);
    expect(STUDIO_NAME.match(FORBIDDEN_BRAND_RE)).toBeNull();
  });
});
