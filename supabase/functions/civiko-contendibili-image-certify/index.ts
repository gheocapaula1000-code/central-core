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
import { decodeImage, sniffImageFormat } from "../_shared/imageDecode.ts";
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
  const dryRun = body.dry_run === true;

  const diagnostics: Record<string, unknown> = {};
  const budget: FetchBudget = { used: 0, max: MAX_TOTAL_REQUESTS };

  // 1) result detail già memorizzati e riusabili --------------------------------
  const { data: attempts, error: attErr } = await sb
    .from("civiko_contendibili_evidence_attempts")
    .select("listing_id,url,queue_id,evidence,commercial_zone_slug")
    .eq("status", "succeeded")
    .not("queue_id", "is", null)
    .order("listing_id", { ascending: true })
    .limit(limit);
  if (attErr) return json({ ok: false, error: "attempts_read_failed", detail: attErr.message }, 500);
  if (!attempts?.length) return json({ ok: true, reprocessed: 0, note: "no_succeeded_details" });

  const queueIds = attempts.map((a) => a.queue_id as string);
  const { data: queueRows, error: qErr } = await sb
    .from("scraping_queue")
    .select("id,result")
    .in("id", queueIds);
  if (qErr) return json({ ok: false, error: "queue_read_failed", detail: qErr.message }, 500);
  const resultById = new Map((queueRows ?? []).map((r) => [r.id as string, r.result]));

  const listingIds = attempts.map((a) => Number(a.listing_id));
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
  const fingerprints: Fp[] = [];

  for (const att of attempts) {
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

    const fetched = await fetchImagesBounded(refs, budget);
    for (const item of fetched) {
      if (!isFetched(item)) {
        downloadFailed++;
        continue;
      }
      const format = sniffImageFormat(item.bytes);
      const img = await decodeImage(item.bytes);
      if (!img) {
        undecodable++;
        diagnostics[`undecodable_${format}`] =
          (Number(diagnostics[`undecodable_${format}`] ?? 0) as number) + 1;
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
  if (!dryRun && usable.length) {
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

  const pairRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const [idA] = eligible[i];
      const [idB] = eligible[j];
      const la = listingById.get(idA);
      const lb = listingById.get(idB);
      if (!la || !lb) continue;
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
    match_version: MATCH_VERSION,
    evidence_kind: EVIDENCE_KIND,
    algo: PHASH_ALGO,
    soglia_hamming: PHASH_MATCH_MAX_DISTANCE,
    soglia_generico: GENERIC_REUSE_THRESHOLD,
    result_riprocessati: reprocessed,
    image_refs_estratti: refsTotal,
    immagini_decodificate: decoded,
    immagini_non_decodificabili: undecodable,
    download_falliti: downloadFailed,
    fingerprint_validi: usable.length,
    fingerprint_scartati: rejectedQuality,
    annunci_con_2_fingerprint: withTwoFingerprints,
    coppie_con_foto_condivise: pairRows.length,
    coppie_certificanti: pairRows.filter((p) => (p.shared_photos as number) >= MIN_SHARED_PHOTOS_PER_PAIR).length,
    budget_richieste_usate: budget.used,
    diagnostics,
  });
});
