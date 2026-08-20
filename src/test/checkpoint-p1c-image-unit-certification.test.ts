import { describe, expect, it } from "vitest";
import jpeg from "jpeg-js";
import {
  fingerprintImage,
  hammingDistance,
  isPhotoMatch,
  lumaEntropy,
  phashFromRgba,
  rejectFingerprint,
  sha256Hex,
  PHASH_MATCH_MAX_DISTANCE,
  type RgbaImage,
} from "../../supabase/functions/_shared/imagePhash";
import {
  checkImageUrl,
  fetchImageSafe,
  fetchImagesBounded,
  isFetched,
  IMAGE_HOST_ALLOWLIST,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_LISTING,
  MAX_TOTAL_REQUESTS,
  FETCH_TIMEOUT_MS,
} from "../../supabase/functions/_shared/imageFetchGuard";
import {
  evaluateImagePhashV1,
  EVIDENCE_KIND,
  MATCH_VERSION,
  type ListingForImageGate,
  type PhotoFp,
} from "../../supabase/functions/_shared/imagePhashV1Gate";

// ───────────────────────────────────────────────────────────────────────────
// CHECKPOINT P1-C — certificazione unità tramite immagini reali.
// I fingerprint sono calcolati sui BYTE decodificati di JPEG generati qui:
// nessun hash di URL, filename o path.
// ───────────────────────────────────────────────────────────────────────────

/* ── generatori di immagini deterministici ──────────────────────────────── */

function scene(w: number, h: number, seed: number): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v =
        128 +
        90 * Math.sin((x / 11) + seed) +
        60 * Math.cos((y / 7) - seed * 1.7) +
        40 * Math.sin((x + y) / 5 + seed * 3);
      const c = Math.max(0, Math.min(255, v));
      data[i] = c;
      data[i + 1] = Math.max(0, Math.min(255, c * 0.85 + 20));
      data[i + 2] = Math.max(0, Math.min(255, 255 - c * 0.6));
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function flatLogo(w = 400, h = 400): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inBar = y > h / 2 - 6 && y < h / 2 + 6 && x > 40 && x < w - 40;
      const c = inBar ? 20 : 250;
      data[i] = data[i + 1] = data[i + 2] = c;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function encodeJpeg(img: RgbaImage, quality: number): Uint8Array {
  return new Uint8Array(
    jpeg.encode({ data: Buffer.from(img.data), width: img.width, height: img.height }, quality).data,
  );
}

function decodeJpeg(bytes: Uint8Array): RgbaImage {
  const d = jpeg.decode(Buffer.from(bytes), { useTArray: true });
  return { width: d.width, height: d.height, data: d.data as Uint8Array };
}

function downscale(img: RgbaImage, factor: number): RgbaImage {
  const w = Math.round(img.width / factor);
  const h = Math.round(img.height / factor);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.round(x * factor));
      const sy = Math.min(img.height - 1, Math.round(y * factor));
      const s = (sy * img.width + sx) * 4;
      const d = (y * w + x) * 4;
      data[d] = img.data[s];
      data[d + 1] = img.data[s + 1];
      data[d + 2] = img.data[s + 2];
      data[d + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/* ── FASE 3 — fingerprint reale ─────────────────────────────────────────── */

describe("P1-C — fingerprint percettivo sui byte reali", () => {
  it("stessa foto ricompressa a qualità diversa → stesso fingerprint percettivo", async () => {
    const src = scene(640, 480, 1);
    const a = decodeJpeg(encodeJpeg(src, 92));
    const b = decodeJpeg(encodeJpeg(src, 45));
    const d = hammingDistance(phashFromRgba(a), phashFromRgba(b));
    expect(d).toBeLessThanOrEqual(PHASH_MATCH_MAX_DISTANCE);
    expect(isPhotoMatch(phashFromRgba(a), phashFromRgba(b))).toBe(true);
  });

  it("stessa foto ridimensionata → resta la stessa scena", () => {
    const src = scene(640, 480, 2);
    const small = downscale(src, 2);
    expect(isPhotoMatch(phashFromRgba(src), phashFromRgba(small))).toBe(true);
  });

  it("fotografie diverse → nessuna corrispondenza", () => {
    const a = phashFromRgba(scene(640, 480, 1));
    const b = phashFromRgba(scene(640, 480, 9));
    expect(hammingDistance(a, b)).toBeGreaterThan(PHASH_MATCH_MAX_DISTANCE);
    expect(isPhotoMatch(a, b)).toBe(false);
  });

  it("il fingerprint non dipende da URL, filename o path", async () => {
    const bytes = encodeJpeg(scene(640, 480, 3), 80);
    const fp1 = await fingerprintImage(bytes, decodeJpeg(bytes));
    const fp2 = await fingerprintImage(bytes, decodeJpeg(bytes));
    expect(fp1.phash).toBe(fp2.phash);
    expect(fp1.sha256).toBe(fp2.sha256);
    expect(fp1.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fp1.phash).toMatch(/^[0-9a-f]{16}$/);
    // hash del path NON coincide con il fingerprint dei byte
    expect(await sha256Hex(new TextEncoder().encode("/image/123/m-c.jpg"))).not.toBe(fp1.sha256);
  });

  it("idempotenza: due esecuzioni consecutive producono lo stesso risultato", async () => {
    const bytes = encodeJpeg(scene(320, 240, 4), 70);
    const img = decodeJpeg(bytes);
    expect(await fingerprintImage(bytes, img)).toEqual(await fingerprintImage(bytes, img));
  });

  it("logo/banner piatto → scartato per bassa entropia", () => {
    const logo = decodeJpeg(encodeJpeg(flatLogo(), 85));
    expect(lumaEntropy(logo)).toBeLessThan(3.2);
    expect(rejectFingerprint({ width: 400, height: 400, entropy: lumaEntropy(logo) })).toBe(
      "BASSA_ENTROPIA",
    );
  });

  it("miniatura troppo piccola → scartata", () => {
    expect(rejectFingerprint({ width: 120, height: 90, entropy: 7 })).toBe("TROPPO_PICCOLA");
  });

  it("immagine ricorrente in molti immobili → materiale generico, scartata", () => {
    expect(rejectFingerprint({ width: 800, height: 600, entropy: 7 }, 5)).toBe("MATERIALE_GENERICO");
    expect(rejectFingerprint({ width: 800, height: 600, entropy: 7 }, 1)).toBeNull();
  });
});

/* ── FASE 2 — sicurezza download ────────────────────────────────────────── */

describe("P1-C — guardia SSRF sui download", () => {
  it.each([
    ["http://pwm.im-cdn.it/image/1/a.jpg", "NON_HTTPS"],
    ["https://evil.example/a.jpg", "HOST_NON_IN_ALLOWLIST"],
    ["https://169.254.169.254/latest/meta-data", "IP_LETTERALE"],
    ["https://localhost/a.jpg", "HOST_PRIVATO"],
    ["https://user:pass@pwm.im-cdn.it/a.jpg", "USERINFO_PRESENTE"],
    ["https://pwm.im-cdn.it:8080/a.jpg", "PORTA_NON_CONSENTITA"],
    ["non-un-url", "URL_MALFORMATO"],
  ])("rifiuta %s", (url, reason) => {
    expect(checkImageUrl(url)).toBe(reason);
  });

  it("accetta soltanto host dei quattro portali osservati", () => {
    expect(checkImageUrl("https://pwm.im-cdn.it/image/1853742385/m-c.jpg")).toBeNull();
    expect(IMAGE_HOST_ALLOWLIST).toContain("st3.idealista.it");
    expect(IMAGE_HOST_ALLOWLIST.some((h) => h.includes("localhost"))).toBe(false);
  });

  it("un redirect fuori allowlist interrompe il download", async () => {
    const budget = { used: 0, max: MAX_TOTAL_REQUESTS };
    const fakeFetch = (async () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example/x.jpg" } })) as unknown as typeof fetch;
    const r = await fetchImageSafe("https://pwm.im-cdn.it/image/1/a.jpg", budget, fakeFetch);
    expect(isFetched(r)).toBe(false);
    expect((r as { reason: string }).reason).toBe("REDIRECT_HOST_NON_IN_ALLOWLIST");
  });

  it("nessun cookie o header autenticato viene inviato", async () => {
    const budget = { used: 0, max: MAX_TOTAL_REQUESTS };
    let seen: Record<string, string> = {};
    const fakeFetch = (async (_u: string, init: RequestInit) => {
      seen = (init.headers ?? {}) as Record<string, string>;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchImageSafe("https://pwm.im-cdn.it/image/1/a.jpg", budget, fakeFetch);
    expect(Object.keys(seen).map((k) => k.toLowerCase())).toEqual(["accept"]);
  });

  it("immagine oltre 5 MB → rifiutata", async () => {
    const budget = { used: 0, max: MAX_TOTAL_REQUESTS };
    const fakeFetch = (async () =>
      new Response(new Uint8Array(4), {
        status: 200,
        headers: { "content-length": String(MAX_IMAGE_BYTES + 1) },
      })) as unknown as typeof fetch;
    const r = await fetchImageSafe("https://pwm.im-cdn.it/image/1/a.jpg", budget, fakeFetch);
    expect((r as { reason: string }).reason).toBe("TROPPO_GRANDE");
  });

  it("timeout → fallimento senza retry infinito", async () => {
    const budget = { used: 0, max: MAX_TOTAL_REQUESTS };
    const fakeFetch = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const r = await fetchImageSafe("https://pwm.im-cdn.it/image/1/a.jpg", budget, fakeFetch);
    expect((r as { reason: string }).reason).toBe("TIMEOUT");
    expect(budget.used).toBe(1);
    expect(FETCH_TIMEOUT_MS).toBe(8000);
  });

  it("massimo 5 immagini per annuncio e budget assoluto rispettato", async () => {
    const budget = { used: 0, max: MAX_TOTAL_REQUESTS };
    const fakeFetch = (async () =>
      new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;
    const urls = Array.from({ length: 20 }, (_, i) => `https://pwm.im-cdn.it/image/${i}/m.jpg`);
    const res = await fetchImagesBounded(urls, budget, fakeFetch);
    expect(res).toHaveLength(MAX_IMAGES_PER_LISTING);
    expect(budget.used).toBe(MAX_IMAGES_PER_LISTING);
    expect(MAX_TOTAL_REQUESTS).toBe(300);
  });

  it("budget esaurito → nessuna ulteriore richiesta di rete", async () => {
    const budget = { used: 300, max: MAX_TOTAL_REQUESTS };
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchImageSafe("https://pwm.im-cdn.it/image/1/a.jpg", budget, fakeFetch);
    expect(calls).toBe(0);
    expect((r as { reason: string }).reason).toBe("BUDGET_RICHIESTE_ESAURITO");
  });
});

/* ── FASE 4 — regola IMAGE_PHASH_V1 ─────────────────────────────────────── */

const photo = (seed: number, patch: Partial<PhotoFp> = {}): PhotoFp => ({
  sha256: `sha-${seed}`,
  phash: phashFromRgba(scene(320, 240, seed)),
  width: 800,
  height: 600,
  entropy: 7.2,
  reuseCount: 1,
  ...patch,
});

const L = (patch: Partial<ListingForImageGate> = {}): ListingForImageGate => ({
  url: "https://www.immobiliare.it/annunci/1/",
  fonte: "immobiliare",
  agencyKey: "agenziaalfa",
  zone: "sud-est-sant-osvaldo",
  tipologia: "appartamento",
  locali: 5,
  mq: 120,
  prezzo: 300000,
  civico: null,
  piano: "p2",
  photos: [photo(1), photo(2), photo(3)],
  ...patch,
});

describe("P1-C — regola IMAGE_PHASH_V1", () => {
  it("due agenzie distinte con 2 foto reali coincidenti → certificato", () => {
    const r = evaluateImagePhashV1([
      L(),
      L({ url: "https://www.immobiliare.it/annunci/2/", agencyKey: "agenziabeta", photos: [photo(1), photo(2), photo(9)] }),
    ]);
    expect(r.certificato).toBe(true);
    expect(r.evidence_kind).toBe(EVIDENCE_KIND);
    expect(r.match_version).toBe(MATCH_VERSION);
    expect(r.coppie[0].corrispondenze).toBe(2);
    expect(r.coppie[0].distanze.every((d) => d <= PHASH_MATCH_MAX_DISTANCE)).toBe(true);
  });

  it("una sola foto coincidente senza segnale di plausibilità → insufficiente", () => {
    const r = evaluateImagePhashV1([
      L({ locali: null, mq: null, tipologia: null, piano: null, photos: [photo(1), photo(8)] }),
      L({
        url: "https://x/2",
        agencyKey: "agenziabeta",
        locali: null,
        mq: null,
        tipologia: null,
        piano: null,
        photos: [photo(1), photo(9)],
      }),
    ]);
    expect(r.certificato).toBe(false);
    expect(r.coppie.some((c) => c.motivi.includes("PROVA_INSUFFICIENTE"))).toBe(true);
  });

  it("stessa agenzia su due portali → non contendibile", () => {
    const r = evaluateImagePhashV1([L(), L({ url: "https://x/2", fonte: "idealista" })]);
    expect(r.certificato).toBe(false);
    expect(r.motivi).toContain("AGENZIE_INSUFFICIENTI");
  });

  it("logo condiviso fra le due agenzie non certifica", () => {
    const logo = photo(1, { entropy: 1.1 });
    const r = evaluateImagePhashV1([
      L({ piano: null, photos: [logo] }),
      L({ url: "https://x/2", agencyKey: "agenziabeta", piano: "p6", photos: [logo] }),
    ]);
    expect(r.certificato).toBe(false);
    expect(r.immagini_scartate).toBe(2);
  });

  it("immagine ricorrente in molti immobili non certifica", () => {
    const generica = photo(1, { reuseCount: 7 });
    const r = evaluateImagePhashV1([
      L({ piano: null, photos: [generica, photo(2, { reuseCount: 7 })] }),
      L({
        url: "https://x/2",
        agencyKey: "agenziabeta",
        piano: "p6",
        photos: [generica, photo(2, { reuseCount: 7 })],
      }),
    ]);
    expect(r.certificato).toBe(false);
  });

  it.each([
    ["prezzo oltre 15%", { prezzo: 200000 }, { prezzo: 400000 }, "PREZZO_OLTRE_15_PCT"],
    ["asta", {}, { asta: true }, "ASTA_O_PROCEDURA"],
    ["MLS/esclusiva", {}, { mls: true }, "MLS_ESCLUSIVA"],
    ["cross-zona", {}, { zone: "centro-storico" }, "ZONE_DIVERSE"],
  ])("le foto coincidenti non superano un conflitto strutturale: %s", (_n, pa, pb, motivo) => {
    const r = evaluateImagePhashV1([
      L({ ...pa, photos: [photo(1), photo(2)] }),
      L({ url: "https://x/2", agencyKey: "agenziabeta", ...pb, photos: [photo(1), photo(2)] }),
    ]);
    expect(r.certificato).toBe(false);
    expect(r.motivi).toContain(motivo);
  });

  it("vietata la transitività A-B-C: se la coppia A-C non regge, il gruppo non è certificato", () => {
    const r = evaluateImagePhashV1([
      L({ url: "https://x/a", agencyKey: "alfa", locali: 2, piano: null, photos: [photo(1), photo(2)] }),
      L({ url: "https://x/b", agencyKey: "beta", photos: [photo(1), photo(2), photo(3), photo(4)] }),
      L({ url: "https://x/c", agencyKey: "gamma", locali: 5, piano: "p6", photos: [photo(3), photo(4)] }),
    ]);
    expect(r.certificato).toBe(false);
    expect(r.motivi).toContain("CLIQUE_INCOMPLETA");
  });

  it("gruppo a tre agenzie con tutte le coppie provate → certificato", () => {
    const set = [photo(1), photo(2), photo(3)];
    const r = evaluateImagePhashV1([
      L({ url: "https://x/a", agencyKey: "alfa", photos: set }),
      L({ url: "https://x/b", agencyKey: "beta", photos: set }),
      L({ url: "https://x/c", agencyKey: "gamma", photos: set }),
    ]);
    expect(r.certificato).toBe(true);
    expect(r.coppie).toHaveLength(3);
  });

  it("nessuna foto disponibile → nessuna certificazione per immagini", () => {
    const r = evaluateImagePhashV1([
      L({ piano: null, locali: null, photos: [] }),
      L({ url: "https://x/2", agencyKey: "agenziabeta", piano: "p6", locali: 2, photos: [] }),
    ]);
    expect(r.certificato).toBe(false);
    expect(r.immagini_confrontate).toBe(0);
  });

  it("idempotenza del verdetto", () => {
    const rows = [L(), L({ url: "https://x/2", agencyKey: "beta", photos: [photo(1), photo(2)] })];
    expect(evaluateImagePhashV1(rows)).toEqual(evaluateImagePhashV1(rows));
  });
});
