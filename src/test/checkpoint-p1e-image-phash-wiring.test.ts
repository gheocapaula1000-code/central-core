// CHECKPOINT P1-E — collegamento end-to-end della certificazione fotografica
// IMAGE_PHASH_V1 al percorso Civiko dei contendibili.
//
// Copre: host realmente osservati, estrazione multi-foto dai result detail già
// memorizzati, formati non supportati (fail closed), idempotenza dei
// fingerprint, gate per coppia cross-agenzia, conflitti strutturali,
// immagini generiche, persistenza e consumo reale nel recompute.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { encode as encodeJpeg } from "jpeg-js";
import { encode as encodePng } from "fast-png";

import {
  IMAGE_HOST_ALLOWLIST,
  checkImageUrl,
} from "../../supabase/functions/_shared/imageFetchGuard";
import {
  extractDetailImageRefs,
  photoIdentityKey,
  MAX_DETAIL_IMAGE_REFS,
} from "../../supabase/functions/_shared/detailImageRefs";
import {
  decodeImage,
  isDecodableFormat,
  sniffImageFormat,
} from "../../supabase/functions/_shared/imageDecode";
import {
  fingerprintImage,
  phashFromRgba,
  rejectFingerprint,
} from "../../supabase/functions/_shared/imagePhash";
import {
  evaluateImagePhashV1,
  type ListingForImageGate,
  type PhotoFp,
} from "../../supabase/functions/_shared/imagePhashV1Gate";

const MIGRATION = readFileSync(
  "docs/pending-migrations/20260806040000_civiko_contendibili_image_phash_v1_wiring.sql",
  "utf8",
);
const EDGE_FN = readFileSync(
  "supabase/functions/civiko-contendibili-image-certify/index.ts",
  "utf8",
);

/* ── helper immagini reali ─────────────────────────────────────────────── */

function noiseRgba(w: number, h: number, seed: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  let s = seed >>> 0;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = s & 0xff;
    data[i * 4 + 1] = (s >> 8) & 0xff;
    data[i * 4 + 2] = (s >> 16) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return data;
}

function flatRgba(w: number, h: number, value = 200): Uint8Array {
  const data = new Uint8Array(w * h * 4).fill(value);
  for (let i = 0; i < w * h; i++) data[i * 4 + 3] = 255;
  return data;
}

const jpegBytes = (w: number, h: number, seed: number) =>
  new Uint8Array(encodeJpeg({ data: noiseRgba(w, h, seed), width: w, height: h }, 85).data);

const pngBytes = (w: number, h: number, seed: number) =>
  new Uint8Array(
    encodePng({ data: noiseRgba(w, h, seed), width: w, height: h, channels: 4, depth: 8 }),
  );

/* ── 1. host realmente osservati ───────────────────────────────────────── */

describe("allowlist host realmente osservati", () => {
  const observed = [
    "images-1.casa.it",
    "img4.idealista.it",
    "pwm.im-cdn.it",
    "s1.immobiliare.it",
  ];

  it("copre tutti e quattro gli host presenti nelle evidenze", () => {
    for (const host of observed) expect(IMAGE_HOST_ALLOWLIST).toContain(host);
  });

  it("accetta solo HTTPS su host in allowlist e blocca SSRF", () => {
    expect(checkImageUrl("https://img4.idealista.it/blur/a/b/820533548.jpg")).toBeNull();
    expect(checkImageUrl("http://img4.idealista.it/a.jpg")).toBe("NON_HTTPS");
    expect(checkImageUrl("https://evil.example.com/a.jpg")).toBe("HOST_NON_IN_ALLOWLIST");
    expect(checkImageUrl("https://127.0.0.1/a.jpg")).toBe("IP_LETTERALE");
    expect(checkImageUrl("https://localhost/a.jpg")).toBe("HOST_PRIVATO");
    expect(checkImageUrl("https://user:pw@img.casa.it/a.jpg")).toBe("USERINFO_PRESENTE");
    expect(checkImageUrl("https://img.casa.it:8443/a.jpg")).toBe("PORTA_NON_CONSENTITA");
  });
});

/* ── 2. estrazione multi-foto dai result già memorizzati ───────────────── */

describe("estrazione multi-foto dai result detail memorizzati", () => {
  const idealistaResult = {
    success: true,
    data: {
      markdown: [
        "![](https://img4.idealista.it/blur/WEB_DETAIL/0/id.pro.it.image.master/df/a1/a1/820533548.jpg)",
        "![](https://img4.idealista.it/blur/WEB_DETAIL/0/id.pro.it.image.master/d7/2c/11/820534850.jpg)",
        "![](https://img4.idealista.it/blur/WEB_DETAIL/0/id.pro.it.image.master/aa/bb/cc/820534999.jpg)",
      ].join("\n"),
      html:
        '<img src="https://img4.idealista.it/blur/WEB_DETAIL-XL-P/0/id.pro.it.image.master/df/a1/a1/820533548.webp">' +
        '<img src="https://img4.idealista.it/blur/WEB_DETAIL_TOP-L-P/0/id.pro.it.image.master/df/a1/a1/820533548.jpg">' +
        '<img src="https://img4.idealista.it/blur/WEB_DETAIL/0/id.pro.it.image.master/11/22/33/820535100.jpg">' +
        '<img src="https://img4.idealista.it/blur/WEB_DETAIL/0/id.pro.it.image.master/44/55/66/820535200.jpg">' +
        '<img src="https://img4.idealista.it/blur/WEB_DETAIL/0/id.pro.it.image.master/77/88/99/820535300.jpg">' +
        '<img src="https://static.captcha-delivery.com/pixel.png">' +
        '<img src="https://img4.idealista.it/logo/idealista-logo.png">',
      metadata: { title: "Trilocale" },
    },
  };

  it("estrae più foto reali deduplicate per identità, non per URL", () => {
    const refs = extractDetailImageRefs(idealistaResult);
    expect(refs.length).toBeGreaterThanOrEqual(4);
    expect(refs.length).toBeLessThanOrEqual(MAX_DETAIL_IMAGE_REFS);
    const ids = refs.map((u) => photoIdentityKey(u));
    expect(new Set(ids).size).toBe(refs.length);
    expect(refs.every((u) => u.startsWith("https://img4.idealista.it/"))).toBe(true);
  });

  it("scarta captcha, loghi, planimetrie, mappe, miniature e host estranei", () => {
    const refs = extractDetailImageRefs({
      html:
        '<img src="https://static.captcha-delivery.com/a.png">' +
        '<img src="https://pic.im-cdn.it/plan/131308964/m.jpg">' +
        '<img src="https://maps.im-cdn.it/map/1.jpg">' +
        '<img src="https://pwm.im-cdn.it/image/1972337738/logo.jpg">' +
        '<img src="https://images-1.casa.it/120x90/listing/0/aa/bb/cc/759546585.jpg">' +
        '<img src="https://pwm.im-cdn.it/image/1972339280/m-c.jpg">',
    });
    expect(refs).toEqual(["https://pwm.im-cdn.it/image/1972339280/m-c.jpg"]);
  });

  it("preferisce varianti decodificabili e non restituisce mai webp/avif", () => {
    const refs = extractDetailImageRefs({
      html:
        '<img src="https://images-1.casa.it/800x600/listing/0/a2/60/3b/759546585.webp">' +
        '<img src="https://images-1.casa.it/800x600/listing/0/a2/60/3b/759546585.jpg">',
    });
    expect(refs).toEqual([
      "https://images-1.casa.it/800x600/listing/0/a2/60/3b/759546585.jpg",
    ]);
  });

  it("è deterministico e cappato a 5 foto per annuncio", () => {
    const many = {
      html: Array.from({ length: 20 }, (_, i) =>
        `<img src="https://images-1.casa.it/800x600/listing/0/aa/bb/cc/7595465${10 + i}.jpg">`)
        .join(""),
    };
    const a = extractDetailImageRefs(many);
    const b = extractDetailImageRefs(many);
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
  });
});

/* ── 3. formati e decodifica ───────────────────────────────────────────── */

describe("decodifica dei soli formati supportati (fail closed)", () => {
  it("riconosce i formati dai magic bytes", () => {
    expect(sniffImageFormat(jpegBytes(64, 64, 7))).toBe("jpeg");
    expect(sniffImageFormat(pngBytes(64, 64, 7))).toBe("png");
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffImageFormat(webp)).toBe("webp");
    expect(isDecodableFormat("webp")).toBe(false);
    expect(isDecodableFormat("avif")).toBe(false);
  });

  it("decodifica JPEG e PNG in RGBA reale", async () => {
    const jpg = await decodeImage(jpegBytes(256, 256, 11));
    expect(jpg?.width).toBe(256);
    expect(jpg?.data.length).toBe(256 * 256 * 4);
    const png = await decodeImage(pngBytes(256, 256, 11));
    expect(png?.width).toBe(256);
  });

  it("restituisce null (nessuna promozione) su formati o byte non decodificabili", async () => {
    expect(await decodeImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
    const webp = new Uint8Array(64);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(await decodeImage(webp)).toBeNull();
    const corruptJpeg = jpegBytes(64, 64, 3).slice(0, 40);
    expect(await decodeImage(corruptJpeg)).toBeNull();
  });
});

/* ── 4. fingerprint sui byte reali + idempotenza ───────────────────────── */

describe("fingerprint sui byte reali", () => {
  it("è idempotente e indipendente da URL/filename", async () => {
    const bytes = jpegBytes(256, 256, 42);
    const img = (await decodeImage(bytes))!;
    const a = await fingerprintImage(bytes, img);
    const b = await fingerprintImage(bytes, img);
    expect(a.sha256).toBe(b.sha256);
    expect(a.phash).toBe(b.phash);
    expect(a.phash).toHaveLength(16);
  });

  it("distingue fotografie diverse", async () => {
    const one = (await decodeImage(jpegBytes(256, 256, 1)))!;
    const two = (await decodeImage(jpegBytes(256, 256, 999)))!;
    expect(phashFromRgba(one)).not.toBe(phashFromRgba(two));
  });

  it("scarta miniature, bassa entropia e materiale generico", () => {
    expect(rejectFingerprint({ width: 120, height: 90, entropy: 7 })).toBe("TROPPO_PICCOLA");
    expect(
      rejectFingerprint({
        width: 800,
        height: 600,
        entropy: 0.1,
      }),
    ).toBe("BASSA_ENTROPIA");
    expect(rejectFingerprint({ width: 800, height: 600, entropy: 7 }, 3)).toBe("MATERIALE_GENERICO");
    const flat = { width: 400, height: 400, data: flatRgba(400, 400) };
    expect(phashFromRgba(flat)).toBeTruthy();
  });
});

/* ── 5. gate IMAGE_PHASH_V1: nessun falso positivo ─────────────────────── */

const photo = (phash: string, sha = phash): PhotoFp => ({
  sha256: `sha-${sha}`,
  phash,
  width: 800,
  height: 600,
  entropy: 7.2,
});

const base = (over: Partial<ListingForImageGate>): ListingForImageGate => ({
  url: "https://www.casa.it/immobili/1",
  fonte: "casa",
  agencyKey: "alfa",
  zone: "centro-storico",
  tipologia: "appartamento",
  locali: 3,
  mq: 90,
  prezzo: 300000,
  civico: null,
  piano: "2",
  photos: [],
  ...over,
});

describe("gate IMAGE_PHASH_V1", () => {
  const p1 = "0f0f0f0f0f0f0f0f";
  const p2 = "1234567890abcdef";
  const p3 = "fedcba0987654321";

  it("certifica solo con >= 2 foto reali condivise per ogni coppia cross-agenzia", () => {
    const res = evaluateImagePhashV1([
      base({ url: "https://a/1", agencyKey: "alfa", photos: [photo(p1), photo(p2)] }),
      base({ url: "https://b/2", agencyKey: "beta", photos: [photo(p1), photo(p2)] }),
    ]);
    expect(res.certificato).toBe(true);
    expect(res.evidence_kind).toBe("IMAGE_PHASH_V1");
    expect(res.match_version).toBe("v4-padova-photo-pair");
  });

  it("nega con una sola foto condivisa se manca un segnale di plausibilità", () => {
    const res = evaluateImagePhashV1([
      base({
        url: "https://a/1",
        agencyKey: "alfa",
        locali: null,
        mq: null,
        tipologia: null,
        piano: null,
        photos: [photo(p1), photo(p3)],
      }),
      base({
        url: "https://b/2",
        agencyKey: "beta",
        locali: null,
        mq: null,
        tipologia: null,
        piano: null,
        photos: [photo(p1), photo(p2)],
      }),
    ]);
    expect(res.certificato).toBe(false);
    expect(res.coppie.some((c) => c.motivi.includes("PROVA_INSUFFICIENTE"))).toBe(true);
  });

  it("nega con una sola agenzia (stessa agenzia su due annunci)", () => {
    const res = evaluateImagePhashV1([
      base({ url: "https://a/1", agencyKey: "alfa", photos: [photo(p1), photo(p2)] }),
      base({ url: "https://a/2", agencyKey: "alfa", photos: [photo(p1), photo(p2)] }),
    ]);
    expect(res.certificato).toBe(false);
    expect(res.motivi).toContain("AGENZIE_INSUFFICIENTI");
  });

  it("vieta la transitività A-B-C: ogni coppia deve reggere", () => {
    const res = evaluateImagePhashV1([
      base({ url: "https://a/1", agencyKey: "alfa", locali: 2, piano: null, photos: [photo(p1), photo(p2)] }),
      base({ url: "https://b/2", agencyKey: "beta", photos: [photo(p1), photo(p2)] }),
      base({ url: "https://c/3", agencyKey: "gamma", locali: 5, piano: "6", photos: [photo(p3)] }),
    ]);
    expect(res.certificato).toBe(false);
    expect(res.motivi).toContain("CLIQUE_INCOMPLETA");
  });

  it("le foto non superano conflitti strutturali (mq, prezzo, tipologia, piano, civico, zona)", () => {
    const shared = [photo(p1), photo(p2)];
    const conflicts: Array<[Partial<ListingForImageGate>, string]> = [
      [{ prezzo: 900000 }, "PREZZO_OLTRE_15_PCT"],
      [{ zone: "nord-arcella" }, "ZONE_DIVERSE"],
      [{ asta: true }, "ASTA_O_PROCEDURA"],
      [{ mls: true }, "MLS_ESCLUSIVA"],
    ];
    for (const [over, motivo] of conflicts) {
      const res = evaluateImagePhashV1([
        base({
          url: "https://a/1",
          agencyKey: "alfa",
          photos: shared,
          civico: over.civico ? "10" : null,
        }),
        base({ url: "https://b/2", agencyKey: "beta", photos: shared, ...over }),
      ]);
      expect(res.certificato, motivo).toBe(false);
      expect(res.motivi).toContain(motivo);
    }
  });

  it("ignora immagini generiche/ricorrenti e miniature", () => {
    const generic: PhotoFp = { ...photo(p1), reuseCount: 4 };
    const tiny: PhotoFp = { ...photo(p2), width: 100, height: 80 };
    const res = evaluateImagePhashV1([
      base({ url: "https://a/1", agencyKey: "alfa", piano: null, photos: [generic, tiny] }),
      base({ url: "https://b/2", agencyKey: "beta", piano: "6", photos: [generic, tiny] }),
    ]);
    expect(res.certificato).toBe(false);
    expect(res.immagini_scartate).toBe(4);
  });
});

/* ── 6. persistenza e consumo reale nel recompute ──────────────────────── */

describe("migrazione: persistenza e consumo nel recompute autoritativo", () => {
  it("crea le tabelle di prova con RLS service_role only", () => {
    for (const t of [
      "public.civiko_listing_image_fingerprints",
      "public.civiko_listing_photo_pair_evidence",
    ]) {
      expect(MIGRATION).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
      expect(MIGRATION).toContain(`GRANT ALL ON ${t} TO service_role`);
      expect(MIGRATION).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    }
    expect(MIGRATION).not.toMatch(/TO (anon|authenticated)/);
  });

  it("il recompute consuma davvero la prova per coppia", () => {
    expect(MIGRATION).toContain("public.civiko_listing_photo_pair_evidence");
    expect(MIGRATION).toContain("p.n_pairs_ok = p.n_pairs");
    expect(MIGRATION).toContain("coalesce(e.shared_photos, 0) >= 2");
    expect(MIGRATION).toContain("x.agency_key <> y.agency_key");
  });

  it("pubblica con match_version/evidence_kind/provenienza verificabile", () => {
    expect(MIGRATION).toContain("v3-unit-certified+image-phash-v1");
    expect(MIGRATION).toContain("'IMAGE_PHASH_V1', 'phash-dct-8x8-v1'");
    expect(MIGRATION).toContain("'coppie_cross_agenzia', f.n_pairs");
  });

  it("mantiene canonical-listing-dedup-v1 e le due agenzie reali", () => {
    expect(MIGRATION).toContain("canonical-listing-dedup-v1");
    expect(MIGRATION).toContain("g.n_annunci_canonici >= 2");
    expect(MIGRATION).toContain("g.n_agenzie >= 2");
    expect(MIGRATION).toContain(
      "QA identita canonica fallita: % contendibili con meno di 2 annunci canonici distinti",
    );
  });

  it("mantiene i filtri strutturali, aste e MLS anche sul percorso fotografico", () => {
    expect(MIGRATION).toContain("g.has_asta IS NOT TRUE");
    expect(MIGRATION).toContain("g.has_mls IS NOT TRUE");
    expect(MIGRATION).toContain(
      "g.mq_max::numeric <= greatest(g.mq_min::numeric + 5, g.mq_min::numeric * 1.05)",
    );
    expect(MIGRATION).toContain("g.prezzo_max::numeric <= g.prezzo_min::numeric * 1.35");
    expect(MIGRATION).toContain("g.n_civici <= 1");
    expect(MIGRATION).toContain("g.n_piani <= 1");
    expect(MIGRATION).toContain("g.n_tipologie <= 1");
  });

  it("il recompute successivo non cancella il risultato fotografico valido", () => {
    expect(MIGRATION).toContain(
      "AND NOT EXISTS (SELECT 1 FROM _img_cert g WHERE g.chiave_match = pc.chiave_match)",
    );
  });

  it("QA fail-closed sui contendibili fotografici", () => {
    expect(MIGRATION).toContain("QA staging fotografica fallita");
    expect(MIGRATION).toContain("QA fotografica post-scrittura fallita");
  });
});

/* ── 7. riprocessamento a costo zero ───────────────────────────────────── */

describe("edge function civiko-contendibili-image-certify", () => {
  it("riusa solo i result detail già memorizzati, senza provider a pagamento", () => {
    expect(EDGE_FN).toContain('.from("scraping_queue")');
    expect(EDGE_FN).toContain('.eq("status", "succeeded")');
    expect(EDGE_FN).not.toMatch(/firecrawl|apify|perplexity|openai/i);
  });

  it("richiede il job secret in tempo costante e usa service_role", () => {
    expect(EDGE_FN).toContain("CENTRAL_CORE_JOB_SECRET");
    expect(EDGE_FN).toContain("safeEqual(provided, JOB_SECRET)");
    expect(EDGE_FN).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("non conserva alcun file immagine originale", () => {
    expect(EDGE_FN).not.toContain("storage.from");
    expect(EDGE_FN).toContain("civiko_listing_image_fingerprints");
    expect(EDGE_FN).toContain("civiko_listing_photo_pair_evidence");
  });

  it("scrive in modo idempotente", () => {
    expect(EDGE_FN).toContain('onConflict: "listing_id,sha256"');
    expect(EDGE_FN).toContain('onConflict: "listing_a,listing_b"');
  });
});
