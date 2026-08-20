// Contratto v4 del certificatore fotografico Civiko One / Padova.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  EVIDENCE_KIND,
  EXPECTED_ALGO,
  evaluateImagePhashV1,
  evaluatePair,
  type ListingForImageGate,
  MATCH_VERSION,
  type PhotoFp,
} from "../_shared/imagePhashV1Gate.ts";

const HASHES: Record<string, string> = {
  f1: "0000000000000000",
  f2: "ffffffffffffffff",
  f3: "0f0f0f0f0f0f0f0f",
  f4: "f0f0f0f0f0f0f0f0",
};

const ph = (seed: string): PhotoFp => ({
  sha256: seed,
  phash: HASHES[seed] ?? seed.padEnd(16, "0").slice(0, 16),
  width: 800,
  height: 600,
  entropy: 6,
});

const L = (o: Partial<ListingForImageGate> & { url: string }): ListingForImageGate => ({
  fonte: "immobiliare",
  agencyKey: "a",
  zone: "centro-storico",
  tipologia: "appartamento",
  locali: 3,
  mq: 90,
  prezzo: 200000,
  civico: "10",
  piano: "2",
  photos: [],
  ...o,
});

Deno.test("versione e algoritmo: contratto v4 esplicito, nessun v3", () => {
  assertEquals(MATCH_VERSION, "v4-padova-photo-pair");
  assertEquals(EVIDENCE_KIND, "IMAGE_PHASH_V1");
  assertEquals(EXPECTED_ALGO, "phash-dct-8x8-v1");
  assert(!MATCH_VERSION.includes("v3"));
});

Deno.test("coppia PHOTO <=10%: 1 foto + mq + prezzo + zona, via/civico assenti", () => {
  const a = L({ url: "a", agencyKey: "a", civico: null, via: null, photos: [ph("f1")] });
  const b = L({ url: "b", agencyKey: "b", prezzo: 209000, civico: null, via: null, photos: [ph("f1")] });
  const p = evaluatePair(a, b);
  assertEquals(p.branch, "PHOTO");
  assertEquals(p.valida, true);
});

Deno.test("coppia PHOTO senza mq non certifica, anche con civico uguale", () => {
  const a = L({ url: "a", agencyKey: "a", mq: null, civico: "10", photos: [ph("f1")] });
  const b = L({ url: "b", agencyKey: "b", mq: null, prezzo: 209000, civico: "10", photos: [ph("f1")] });
  const p = evaluatePair(a, b);
  assert(p.motivi.includes("MQ_INCOMPATIBILI"));
  assertEquals(p.valida, false);
});

Deno.test("coppia PHOTO 10-15%: servono 2 foto, 1 non basta", () => {
  const one = evaluatePair(
    L({ url: "a", agencyKey: "a", photos: [ph("f1")] }),
    L({ url: "b", agencyKey: "b", prezzo: 226000, civico: null, photos: [ph("f1")] }),
  );
  assertEquals(one.valida, false);
  const two = evaluatePair(
    L({ url: "a", agencyKey: "a", photos: [ph("f1"), ph("f2")] }),
    L({ url: "b", agencyKey: "b", prezzo: 226000, civico: null, photos: [ph("f1"), ph("f2")] }),
  );
  assertEquals(two.branch, "PHOTO");
  assertEquals(two.valida, true);
});

Deno.test("oltre il 15% sempre rifiutato, anche con molte foto", () => {
  const p = evaluatePair(
    L({ url: "a", agencyKey: "a", photos: [ph("f1"), ph("f2"), ph("f3")] }),
    L({ url: "b", agencyKey: "b", prezzo: 240000, photos: [ph("f1"), ph("f2"), ph("f3")] }),
  );
  assert(p.motivi.includes("PREZZO_OLTRE_15_PCT"));
  assertEquals(p.valida, false);
});

Deno.test("reject comuni su coppia fotografica: agenzia, canonical, asta, MLS, zona", () => {
  const base = { photos: [ph("f1"), ph("f2")] };
  const mk = (o: Partial<ListingForImageGate>) =>
    evaluatePair(
      L({ url: "a", agencyKey: "a", ...base }),
      L({ url: "b", agencyKey: "b", ...base, ...o }),
    );
  assert(mk({ agencyKey: "a" }).motivi.includes("STESSA_AGENZIA"));
  assert(
    evaluatePair(
      L({ url: "a", agencyKey: "a", canonicalListingId: "K", ...base }),
      L({ url: "b", agencyKey: "b", canonicalListingId: "K", ...base }),
    ).motivi.includes("CANONICAL_DUPLICATA"),
  );
  assert(mk({ asta: true }).motivi.includes("ASTA_O_PROCEDURA"));
  assert(mk({ mls: true }).motivi.includes("MLS_ESCLUSIVA"));
  assert(mk({ zone: "nord-arcella" }).motivi.includes("ZONE_DIVERSE"));
});

Deno.test("gruppo PHOTO: locali/piano/civico possono mancare o divergere", () => {
  const g = evaluateImagePhashV1([
    L({ url: "a", agencyKey: "a", locali: null, piano: null, tipologia: null, bagni: 1, civico: null, photos: [ph("f1"), ph("f2")] }),
    L({ url: "b", agencyKey: "b", locali: 1, piano: "5", tipologia: "attico", bagni: 3, prezzo: 215000, civico: "99", photos: [ph("f1"), ph("f2")] }),
  ]);
  assertEquals(g.motivi, []);
  assertEquals(g.certificato, true);
  assertEquals(g.n_pairs_photo, 1);
});

Deno.test("gruppo senza foto condivise non certifica (geo-text ritirato)", () => {
  const g = evaluateImagePhashV1([
    L({ url: "a", agencyKey: "a" }),
    L({ url: "b", agencyKey: "b", prezzo: 210000 }),
  ]);
  assertEquals(g.certificato, false);
  assert(g.motivi.includes("PROVA_INSUFFICIENTE"));
});

Deno.test("complete-link: A-B e B-C senza A-C non certificano", () => {
  const a = L({ url: "a", agencyKey: "a", photos: [ph("f1"), ph("f2")] });
  const b = L({ url: "b", agencyKey: "b", prezzo: 210000, photos: [ph("f1"), ph("f2"), ph("f3"), ph("f4")] });
  const c = L({ url: "c", agencyKey: "c", prezzo: 212000, mq: 41, locali: 1, piano: "9", tipologia: "loft", photos: [ph("f3"), ph("f4")] });
  const g = evaluateImagePhashV1([a, b, c]);
  assertEquals(g.n_pairs_attese, 3);
  assert(g.motivi.includes("CLIQUE_INCOMPLETA"));
  assertEquals(g.certificato, false);
});

Deno.test("nessuna soglia legacy 35% nel contratto", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/imagePhashV1Gate.ts");
  assert(!/1\.35|35_PCT|35%/.test(src), "riferimenti al 35% legacy vietati");
  assert(!/v3-unit-certified/.test(src), "versione v3 legacy vietata");
});
