// civiko-contendibili-image-certify
// ─────────────────────────────────────────────────────────────────────────────
// Collega END-TO-END la prova fotografica al percorso Civiko dei contendibili.
//
// Cosa fa (solo Civiko / Padova, additivo):
//  1. rilegge i result detail GIÀ memorizzati in scraping_queue (nessuno
//     scraping, nessuna chiamata a pagamento);
//  2. estrae fino a 5 URL di fotografie reali (multi-foto) e li persiste in
//     padova_listings.ev_image_refs + civiko_contendibili_evidence_attempts;
//  3. scarica i byte con allowlist/SSRF/redirect/timeout/budget e calcola il
//     fingerprint percettivo sui BYTE decodificati (mai su URL o filename);
//  4. persiste i fingerprint (idempotente, service_role only) senza
//     conservare alcun file immagine originale;
//  5. calcola le prove per COPPIA cross-agenzia (>= 2 foto reali condivise)
//     che il recompute autoritativo consuma per la certificazione
//     IMAGE_PHASH_V1.
//
// Nessun cron viene attivato da questa funzione.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { extractDetailImageRefs, MAX_DETAIL_IMAGE_REFS } from "../_shared/detailImageRefs.ts";
import {
  fetchImagesBounded,
  isFetched,
  MAX_TOTAL_REQUESTS,
  type FetchBudget,
} from "../_shared/imageFetchGuard.ts";
import { decodeImageWithReason, sniffImageFormat, type Decoders } from "../_shared/imageDecode.ts";
// Import statici: l'edge runtime non risolve import dinamici con specifier
// variabile. I decoder vengono iniettati nel modulo condiviso.
import jpegJs from "npm:jpeg-js@0.4.4";
import * as fastPng from "npm:fast-png@8.0.0";

const DECODERS: Decoders = {
  jpeg: jpegJs as unknown as Decoders["jpeg"],
  png: fastPng as unknown as Decoders["png"],
};
import {
  fingerprintImage,
  GENERIC_REUSE_THRESHOLD,
  hammingDistance,
  isPhotoMatch,
  PHASH_ALGO,
  PHASH_MATCH_MAX_DISTANCE,
  rejectFingerprint,
} from "../_shared/imagePhash.ts";
import {
  EVIDENCE_KIND,
  MATCH_VERSION,
  MIN_SHARED_PHOTOS_PER_PAIR,
} from "../_shared/imagePhashV1Gate.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

const DEFAULT_LIMIT = 40;
const HARD_LIMIT = 120;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function safeEqual(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normAgency(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

type Fp = {
  listing_id: number;
  sha256: string;
  phash: string;
  width: number;
  height: number;
  bytes: number;
  entropy: number;
  algo: string;
  source_host: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const provided = req.headers.get("x-job-secret") ?? "";
  if (!JOB_SECRET || !safeEqual(provided, JOB_SECRET)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch { /* body opzionale */ }

  const limit = Math.min(
    HARD_LIMIT,
    Math.max(1, Number(body.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT),
  );
  // Coda mutante: nessun offset. L'avanzamento è oldest-first via marker.
  const afterListingId = Number.isFinite(Number(body.after_listing_id))
    ? Math.max(0, Number(body.after_listing_id))
    : 0;
  const pipelineRunId = typeof body.pipeline_run_id === "string" ? body.pipeline_run_id : null;
  const dryRun = body.dry_run === true;
  // pairs_only: ricalcola le prove per coppia dai fingerprint GIA' persistiti,
  // senza scaricare né decodificare nulla (nessun costo, nessun provider).
  const pairsOnly = body.pairs_only === true;

  const diagnostics: Record<string, unknown> = {};
  const budget: FetchBudget = { used: 0, max: MAX_TOTAL_REQUESTS };

  // 1) result detail già memorizzati e riusabili --------------------------------
  let attempts: Array<Record<string, unknown>> = [];
  if (!pairsOnly) {
    const { data, error: attErr } = await sb
      .from("civiko_contendibili_evidence_attempts")
      .select("listing_id,url,queue_id,evidence,commercial_zone_slug")
      .eq("status", "succeeded")
      .not("queue_id", "is", null)
      .gt("listing_id", afterListingId)
      .order("listing_id", { ascending: true })
      .limit(limit);
    if (attErr) return json({ ok: false, error: "attempts_read_failed", detail: attErr.message }, 500);
    // Nessun detail riusabile non è un errore: resta la fonte raw_json (2b).
    attempts = (data ?? []) as Array<Record<string, unknown>>;

  }

  const resultById = new Map<string, unknown>();
  if (!pairsOnly && attempts.length) {
    const queueIds = attempts.map((a) => a.queue_id as string);
    const { data: queueRows, error: qErr } = await sb
      .from("scraping_queue")
      .select("id,result")
      .in("id", queueIds);
    if (qErr) return json({ ok: false, error: "queue_read_failed", detail: qErr.message }, 500);
    for (const r of queueRows ?? []) resultById.set(r.id as string, r.result);
  }

  // 1b) Fonte additiva: fotografie GIÀ memorizzate in
  // padova_listings.raw_json.media.images (nessuno scraping, nessun provider).
  // Solo annunci attivi del perimetro Civiko con zona ufficiale valorizzata.
  type RawJsonRow = {
    id: number;
    url: string | null;
    fonte: string | null;
    agency: string | null;
    commercial_zone_slug: string | null;
    raw_json: Record<string, unknown> | null;
  };
  let rawJsonRows: RawJsonRow[] = [];
  let scanned = 0;
  let remaining: number | null = null;
  if (!pairsOnly) {
    const { data: rj, error: rjErr } = await sb
      .from("padova_listings")
      .select("id,url,fonte,agency,commercial_zone_slug,raw_json")
      .is("expired_at", null)
      .not("commercial_zone_slug", "is", null)
      .not("raw_json->media->images", "is", null)
      .gt("id", afterListingId)
      .order("id", { ascending: true })
      .limit(limit);
    if (rjErr) {
      return json({ ok: false, error: "raw_json_read_failed", detail: rjErr.message }, 500);
    }
    rawJsonRows = (rj ?? []) as RawJsonRow[];
    scanned = rawJsonRows.length;
    // Idempotenza: salta gli annunci che hanno già fingerprint persistiti.
    if (rawJsonRows.length) {
      const ids = rawJsonRows.map((r) => Number(r.id));
      const { data: already, error: aErr } = await sb
        .from("civiko_listing_image_fingerprints")
        .select("listing_id")
        .in("listing_id", ids);
      if (aErr) {
        return json({ ok: false, error: "fingerprints_read_failed", detail: aErr.message }, 500);
      }
      const done = new Set((already ?? []).map((r) => Number(r.listing_id)));
      rawJsonRows = rawJsonRows.filter((r) => !done.has(Number(r.id)));
    }
    // Quanti annunci restano oltre l'ultimo marker di questo giro.
    const lastScanned = scanned
      ? Math.max(...(rj ?? []).map((r) => Number(r.id)))
      : afterListingId;
    const { count: rest } = await sb
      .from("padova_listings")
      .select("id", { count: "exact", head: true })
      .is("expired_at", null)
      .not("commercial_zone_slug", "is", null)
      .not("raw_json->media->images", "is", null)
      .gt("id", lastScanned);
    remaining = typeof rest === "number" ? rest : null;
  }



  // Annunci coinvolti: nel giro pairs_only sono quelli con fingerprint persistiti.
  let listingIds: number[] = Array.from(
    new Set([
      ...attempts.map((a) => Number(a.listing_id)),
      ...rawJsonRows.map((r) => Number(r.id)),
    ]),
  );
  let storedFingerprints: Fp[] = [];
  if (pairsOnly) {
    const { data: fps, error: fErr } = await sb
      .from("civiko_listing_image_fingerprints")
      .select("listing_id,sha256,phash,width,height,bytes,entropy,algo,source_host")
      .limit(5000);
    if (fErr) return json({ ok: false, error: "fingerprints_read_failed", detail: fErr.message }, 500);
    storedFingerprints = (fps ?? []).map((f) => ({
      listing_id: Number(f.listing_id),
      sha256: f.sha256 as string,
      phash: f.phash as string,
      width: Number(f.width),
      height: Number(f.height),
      bytes: Number(f.bytes),
      entropy: Number(f.entropy),
      algo: f.algo as string,
      source_host: (f.source_host as string) ?? "",
    }));
    listingIds = Array.from(new Set(storedFingerprints.map((f) => f.listing_id)));
    if (!listingIds.length) return json({ ok: true, pairs_only: true, note: "no_fingerprints" });
  }
  if (!listingIds.length) {
    // Nessun candidato nuovo dopo il marker: zero-novità esplicita, non guasto.
    return json({
      ok: true,
      reprocessed: 0,
      attempted: 0,
      scanned,
      remaining: remaining ?? 0,
      last_listing_id: afterListingId,
      pipeline_run_id: pipelineRunId,
      zero_novelty: true,
      note: "no_reusable_photo_sources",
    });
  }
  const lastListingId = Math.max(afterListingId, ...listingIds);


  const { data: listings, error: lErr } = await sb
    .from("padova_listings")
    .select("id,url,fonte,agency,commercial_zone_slug,ev_via_norm,ev_image_refs")
    .in("id", listingIds);
  if (lErr) return json({ ok: false, error: "listings_read_failed", detail: lErr.message }, 500);
  const listingById = new Map((listings ?? []).map((l) => [Number(l.id), l]));


  // 2) estrazione multi-foto + 3) fingerprint sui byte reali --------------------
  let reprocessed = 0;
  let refsTotal = 0;
  let decoded = 0;
  let undecodable = 0;
  let downloadFailed = 0;
  let rejectedQuality = 0;
  const fingerprints: Fp[] = pairsOnly ? storedFingerprints : [];

  // Scarica i byte reali e calcola i fingerprint. La protezione resource-limit
  // (allowlist host, SSRF, redirect, timeout, budget globale) resta invariata.
  const ingestRefs = async (listingId: number, refs: string[]): Promise<void> => {
    const fetched = await fetchImagesBounded(refs, budget);
    for (const item of fetched) {
      if (!isFetched(item)) {
        downloadFailed++;
        continue;
      }
      const format = sniffImageFormat(item.bytes);
      const outcome = await decodeImageWithReason(item.bytes, DECODERS);
      const img = outcome.image;
      if (!img) {
        undecodable++;
        const key = `undecodable_${format}_${outcome.reason ?? "SCONOSCIUTO"}`;
        diagnostics[key] = (Number(diagnostics[key] ?? 0) as number) + 1;
        continue;
      }
      decoded++;
      const fp = await fingerprintImage(item.bytes, img);
      let host = "";
      try {
        host = new URL(item.url).hostname;
      } catch { /* già validato dal guard */ }
      fingerprints.push({
        listing_id: listingId,
        sha256: fp.sha256,
        phash: fp.phash,
        width: fp.width,
        height: fp.height,
        bytes: fp.bytes,
        entropy: Number(fp.entropy.toFixed(4)),
        algo: fp.algo,
        source_host: host,
      });
    }
  };

  for (const att of pairsOnly ? [] : attempts) {
    const listingId = Number(att.listing_id);
    const listing = listingById.get(listingId);
    if (!listing) continue;
    const result = resultById.get(att.queue_id as string);
    if (!result) continue;

    const refs = extractDetailImageRefs(result, MAX_DETAIL_IMAGE_REFS);
    reprocessed++;
    refsTotal += refs.length;
    if (!refs.length) continue;

    if (!dryRun) {
      await sb.from("padova_listings").update({ ev_image_refs: refs }).eq("id", listingId);
      const evidence = (att.evidence ?? {}) as Record<string, unknown>;
      await sb
        .from("civiko_contendibili_evidence_attempts")
        .update({
          evidence: { ...evidence, image_refs: refs, image_refs_version: "civiko-image-refs-v2" },
          updated_at: new Date().toISOString(),
        })
        .eq("listing_id", listingId);
    }

    await ingestRefs(listingId, refs);
  }

  // 2b) estrazione multi-foto dalle immagini già memorizzate in raw_json.
  let rawJsonProcessed = 0;
  let rawJsonRefs = 0;
  for (const row of pairsOnly ? [] : rawJsonRows) {
    const listingId = Number(row.id);
    if (!listingById.has(listingId)) continue;
    const media = (row.raw_json?.media ?? null) as Record<string, unknown> | null;
    const images = media?.images ?? null;
    if (!images) continue;

    const refs = extractDetailImageRefs(images, MAX_DETAIL_IMAGE_REFS);
    rawJsonProcessed++;
    refsTotal += refs.length;
    rawJsonRefs += refs.length;
    if (!refs.length) continue;

    if (!dryRun) {
      await sb.from("padova_listings").update({ ev_image_refs: refs }).eq("id", listingId);
    }

    await ingestRefs(listingId, refs);
  }


  // materiale generico/ricorrente: stessa immagine in >= 3 annunci scollegati
  const reuse = new Map<string, Set<number>>();
  for (const f of fingerprints) {
    const set = reuse.get(f.sha256) ?? new Set<number>();
    set.add(f.listing_id);
    reuse.set(f.sha256, set);
  }
  const usable = fingerprints.filter((f) => {
    const reuseCount = reuse.get(f.sha256)?.size ?? 1;
    const reason = rejectFingerprint(f, reuseCount);
    if (reason) {
      rejectedQuality++;
      diagnostics[`scartate_${reason}`] =
        (Number(diagnostics[`scartate_${reason}`] ?? 0) as number) + 1;
      return false;
    }
    return true;
  });

  // 4) persistenza idempotente dei fingerprint ---------------------------------
  if (!dryRun && !pairsOnly && usable.length) {
    const { error } = await sb
      .from("civiko_listing_image_fingerprints")
      .upsert(
        usable.map((f) => ({ ...f, updated_at: new Date().toISOString() })),
        { onConflict: "listing_id,sha256" },
      );
    if (error) return json({ ok: false, error: "fingerprints_write_failed", detail: error.message }, 500);
  }

  // 5) prove per coppia cross-agenzia ------------------------------------------
  const byListing = new Map<number, Fp[]>();
  for (const f of usable) {
    const arr = byListing.get(f.listing_id) ?? [];
    arr.push(f);
    byListing.set(f.listing_id, arr);
  }
  const eligible = Array.from(byListing.entries()).filter(([, v]) => v.length >= MIN_SHARED_PHOTOS_PER_PAIR);
  const withTwoFingerprints = eligible.length;

  // Identità canonica: due righe che sono lo STESSO annuncio di portale
  // (stesso id canonico) non possono mai costituire prova di contendibilità,
  // anche se le agenzie dichiarate differiscono per filiale o formattazione.
  const canonicalById = new Map<number, string>();
  for (const [id] of eligible) {
    const l = listingById.get(id);
    const url = (l?.url as string | undefined) ?? "";
    if (!url) continue;
    const { data: canon } = await sb.rpc("padova_listing_canonical_id", {
      p_url: url,
      p_fonte: (l?.fonte as string | null) ?? null,
    });
    if (typeof canon === "string" && canon) canonicalById.set(id, canon);
  }
  let scartatiStessoAnnuncio = 0;

  const pairRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const [idA] = eligible[i];
      const [idB] = eligible[j];
      const la = listingById.get(idA);
      const lb = listingById.get(idB);
      if (!la || !lb) continue;
      const canA = canonicalById.get(idA);
      const canB = canonicalById.get(idB);
      if (canA && canB && canA === canB) {
        scartatiStessoAnnuncio++;
        continue;
      }
      const agencyA = normAgency(la.agency as string | null);
      const agencyB = normAgency(lb.agency as string | null);
      if (!agencyA || !agencyB || agencyA === agencyB) continue;
      if ((la.commercial_zone_slug ?? null) !== (lb.commercial_zone_slug ?? null)) continue;


      const pa = byListing.get(idA)!;
      const pb = byListing.get(idB)!;
      const distances: number[] = [];
      const usedA = new Set<string>();
      const usedB = new Set<string>();
      for (const x of pa) {
        for (const y of pb) {
          if (usedA.has(x.phash) || usedB.has(y.phash)) continue;
          if (x.sha256 === y.sha256 || isPhotoMatch(x.phash, y.phash)) {
            distances.push(hammingDistance(x.phash, y.phash));
            usedA.add(x.phash);
            usedB.add(y.phash);
            break;
          }
        }
      }
      if (!distances.length) continue;
      const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA];
      pairRows.push({
        listing_a: lo,
        listing_b: hi,
        agency_a: idA < idB ? agencyA : agencyB,
        agency_b: idA < idB ? agencyB : agencyA,
        shared_photos: distances.length,
        distances,
        algo: PHASH_ALGO,
        soglia: PHASH_MATCH_MAX_DISTANCE,
        match_version: MATCH_VERSION,
        evidence_kind: EVIDENCE_KIND,
        computed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  }

  if (!dryRun && pairRows.length) {
    const { error } = await sb
      .from("civiko_listing_photo_pair_evidence")
      .upsert(pairRows, { onConflict: "listing_a,listing_b" });
    if (error) return json({ ok: false, error: "pairs_write_failed", detail: error.message }, 500);
  }

  return json({
    ok: true,
    dry_run: dryRun,
    pairs_only: pairsOnly,
    offset,
    limit,
    match_version: MATCH_VERSION,
    evidence_kind: EVIDENCE_KIND,
    algo: PHASH_ALGO,
    soglia_hamming: PHASH_MATCH_MAX_DISTANCE,
    soglia_generico: GENERIC_REUSE_THRESHOLD,
    result_riprocessati: reprocessed,
    raw_json_annunci_processati: rawJsonProcessed,
    raw_json_image_refs_estratti: rawJsonRefs,
    image_refs_estratti: refsTotal,

    immagini_decodificate: decoded,
    immagini_non_decodificabili: undecodable,
    download_falliti: downloadFailed,
    fingerprint_validi: usable.length,
    fingerprint_scartati: rejectedQuality,
    annunci_con_2_fingerprint: withTwoFingerprints,
    coppie_con_foto_condivise: pairRows.length,
    coppie_scartate_stesso_annuncio: scartatiStessoAnnuncio,
    coppie_certificanti: pairRows.filter((p) => (p.shared_photos as number) >= MIN_SHARED_PHOTOS_PER_PAIR).length,
    budget_richieste_usate: budget.used,
    diagnostics,
  });
});
