// civiko-contendibili-image-certify
// ─────────────────────────────────────────────────────────────────────────────
// Collega END-TO-END la prova fotografica al percorso Civiko dei contendibili.
//
// Cosa fa (solo Civiko / Padova, additivo):
//  1. seleziona in modo DETERMINISTICO al massimo 4 listing unici TOTALI
//     (evidence attempts + raw_json), oldest-first, perimetro Padova + 8 zone;
//  2. li marca ATOMICAMENTE per pipeline_run_id PRIMA di lavorarli (anche se
//     non hanno foto o non sono decodificabili): la coda avanza sempre e nessun
//     listing viene ritentato più di 4 volte;
//  3. estrae fino a 5 URL di fotografie reali e li persiste in
//     padova_listings.ev_image_refs + civiko_contendibili_evidence_attempts;
//  4. scarica i byte con allowlist/SSRF/redirect/timeout/budget e calcola il
//     fingerprint percettivo sui BYTE decodificati;
//  5. calcola le prove per COPPIA cross-agenzia (pairs_only pagina TUTTI i
//     fingerprint) sostituendo le prove stantie senza residui.
//
// Nessuno scraping, nessun provider a pagamento, nessun cron attivato qui.

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

/** Hard limit TOTALE di listing unici trattati per invocazione. */
export const TOTAL_LISTINGS_PER_INVOCATION = 4;
/** Un listing non viene mai ritentato più di così. */
export const MAX_ATTEMPTS_PER_LISTING = 4;
/** Paginazione delle fonti candidate: nessun tetto arbitrario pre-filtro. */
const CANDIDATE_PAGE_SIZE = 500;
const CANDIDATE_MAX_PAGES = 200;
/** Paginazione completa dei fingerprint: nessun tetto arbitrario. */
const FINGERPRINT_PAGE_SIZE = 1000;
const FINGERPRINT_MAX_PAGES = 200;
/** Paginazione completa della tabella di avanzamento (nessun cap a 5000). */
const ATTEMPTS_PAGE_SIZE = 1000;
const ATTEMPTS_MAX_PAGES = 500;

/** Perimetro ufficiale Civiko One / Padova: 8 zone commerciali. */
export const CIVIKO_ZONE_SLUGS = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "est-forcellini-camin",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
] as const;

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

  // Nessun cursore e nessun offset: la coda muta mentre la si consuma.
  // Il limite è un tetto TOTALE di listing unici, mai due limiti sommati.
  const limit = Math.min(
    TOTAL_LISTINGS_PER_INVOCATION,
    Math.max(1, Number(body.limit ?? TOTAL_LISTINGS_PER_INVOCATION) || TOTAL_LISTINGS_PER_INVOCATION),
  );
  const pipelineRunId = typeof body.pipeline_run_id === "string" ? body.pipeline_run_id : null;
  const dryRun = body.dry_run === true;
  // pairs_only: ricalcola le prove per coppia dai fingerprint GIÀ persistiti,
  // senza scaricare né decodificare nulla (nessun costo, nessun provider).
  const pairsOnly = body.pairs_only === true;

  const runStartedAt = new Date().toISOString();
  const diagnostics: Record<string, unknown> = {};
  const budget: FetchBudget = { used: 0, max: MAX_TOTAL_REQUESTS };
  const zoneScope = [...CIVIKO_ZONE_SLUGS];

  // ── Marker di progresso monotono (non offset, non id) ───────────────────
  const progressMarker = async (): Promise<number> => {
    const q = sb
      .from("civiko_image_certify_attempts")
      .select("listing_id", { count: "exact", head: true });
    const { count, error } = pipelineRunId
      ? await q.eq("last_pipeline_run_id", pipelineRunId)
      : await q;
    if (error) return 0;
    return typeof count === "number" ? count : 0;
  };

  // ── Selezione deterministica dei candidati ──────────────────────────────
  type Candidate = {
    listing_id: number;
    source: "evidence" | "raw_json";
    queue_id?: string;
    source_fp: string | null;
  };
  let selected: Candidate[] = [];
  let scanned = 0;
  let remainingEligible = 0;
  let remainingExact = true;
  const exclusions: Record<string, number> = {};

  if (!pairsOnly) {
    // Avanzamento: paginazione COMPLETA, nessun cap arbitrario a 5000 righe.
    const attemptState = new Map<number, AttemptState>();
    for (let page = 0; page < ATTEMPTS_MAX_PAGES; page++) {
      const from = page * ATTEMPTS_PAGE_SIZE;
      const { data, error } = await sb
        .from("civiko_image_certify_attempts")
        .select("listing_id,attempts,last_pipeline_run_id,terminal,image_source_fp")
        .order("listing_id", { ascending: true })
        .range(from, from + ATTEMPTS_PAGE_SIZE - 1);
      if (error) {
        return json({ ok: false, error: "attempts_progress_read_failed", detail: error.message }, 500);
      }
      const rows = data ?? [];
      for (const r of rows) {
        attemptState.set(Number(r.listing_id), {
          attempts: Number(r.attempts) || 0,
          last_pipeline_run_id: (r.last_pipeline_run_id as string | null) ?? null,
          terminal: r.terminal === true,
          image_source_fp: (r.image_source_fp as string | null) ?? null,
        });
      }
      if (rows.length < ATTEMPTS_PAGE_SIZE) break;
      if (page === ATTEMPTS_MAX_PAGES - 1) {
        return json({ ok: false, error: "attempts_pagination_overflow" }, 500);
      }
    }

    // Pool unico ordinato oldest-first: nessun limite PRIMA delle esclusioni.
    // Fonte A — detail già memorizzati e riusabili.
    const pool = new Map<number, Candidate>();
    for (let page = 0; page < CANDIDATE_MAX_PAGES; page++) {
      const from = page * CANDIDATE_PAGE_SIZE;
      const { data, error } = await sb
        .from("civiko_contendibili_evidence_attempts")
        .select("listing_id,queue_id")
        .eq("status", "succeeded")
        .not("queue_id", "is", null)
        .order("listing_id", { ascending: true })
        .range(from, from + CANDIDATE_PAGE_SIZE - 1);
      if (error) {
        return json({ ok: false, error: "attempts_read_failed", detail: error.message }, 500);
      }
      const rows = data ?? [];
      for (const r of rows) {
        const id = Number(r.listing_id);
        if (!Number.isFinite(id) || pool.has(id)) continue;
        pool.set(id, { listing_id: id, source: "evidence", queue_id: String(r.queue_id), source_fp: null });
      }
      if (rows.length < CANDIDATE_PAGE_SIZE) break;
      if (page === CANDIDATE_MAX_PAGES - 1) remainingExact = false;
    }

    // Fonte B — foto già memorizzate in raw_json, perimetro esatto.
    for (let page = 0; page < CANDIDATE_MAX_PAGES; page++) {
      const from = page * CANDIDATE_PAGE_SIZE;
      const { data, error } = await sb
        .from("padova_listings")
        .select("id")
        .is("expired_at", null)
        .eq("comune", "Padova")
        .in("commercial_zone_slug", zoneScope)
        .not("raw_json->media->images", "is", null)
        .order("id", { ascending: true })
        .range(from, from + CANDIDATE_PAGE_SIZE - 1);
      if (error) {
        return json({ ok: false, error: "raw_json_read_failed", detail: error.message }, 500);
      }
      const rows = data ?? [];
      for (const r of rows) {
        const id = Number(r.id);
        if (!Number.isFinite(id) || pool.has(id)) continue;
        pool.set(id, { listing_id: id, source: "raw_json", source_fp: null });
      }
      if (rows.length < CANDIDATE_PAGE_SIZE) break;
      if (page === CANDIDATE_MAX_PAGES - 1) remainingExact = false;
    }
    scanned = pool.size;

    const poolIds = Array.from(pool.keys()).sort((a, b) => a - b);

    // Chi ha già fingerprint viene saltato (query .in in chunk bounded).
    const fingerprinted = new Set<number>();
    for (const part of chunk(poolIds)) {
      const { data, error } = await sb
        .from("civiko_listing_image_fingerprints")
        .select("listing_id")
        .in("listing_id", part);
      if (error) {
        return json({ ok: false, error: "fingerprints_read_failed", detail: error.message }, 500);
      }
      for (const r of data ?? []) fingerprinted.add(Number(r.listing_id));
    }

    // Perimetro esatto: attivi, Comune di Padova, 8 slug ufficiali.
    const inScope = new Set<number>();
    for (const part of chunk(poolIds)) {
      const { data, error } = await sb
        .from("padova_listings")
        .select("id")
        .in("id", part)
        .is("expired_at", null)
        .eq("comune", "Padova")
        .in("commercial_zone_slug", zoneScope);
      if (error) {
        return json({ ok: false, error: "scope_read_failed", detail: error.message }, 500);
      }
      for (const r of data ?? []) inScope.add(Number(r.id));
    }

    // Impronta CORRENTE della fonte immagine, solo per i terminali in perimetro:
    // un no_photo torna lavorabile appena la fonte cambia davvero.
    const terminalIds = poolIds.filter((id) =>
      inScope.has(id) && !fingerprinted.has(id) && attemptState.get(id)?.terminal === true &&
      (attemptState.get(id)?.attempts ?? 0) < MAX_ATTEMPTS_PER_LISTING
    );
    const currentSourceFp = new Map<number, string | null>();
    for (const part of chunk(terminalIds)) {
      const { data, error } = await sb
        .from("padova_listings")
        .select("id,ev_image_refs,images:raw_json->media->images")
        .in("id", part);
      if (error) {
        return json({ ok: false, error: "source_fp_read_failed", detail: error.message }, 500);
      }
      for (const r of data ?? []) {
        currentSourceFp.set(
          Number(r.id),
          await sourceFingerprint({
            images: (r as Record<string, unknown>).images ?? null,
            refs: (r as Record<string, unknown>).ev_image_refs ?? null,
          }),
        );
      }
    }

    // Scansione oldest-first fino a `limit` eleggibili oppure EOF: il residuo
    // è autoritativo perché deriva dalla scansione completa del pool.
    for (const id of poolIds) {
      const cand = pool.get(id)!;
      const reason = eligibilityReason({
        attempt: attemptState.get(id),
        maxAttempts: MAX_ATTEMPTS_PER_LISTING,
        pipelineRunId,
        hasFingerprint: fingerprinted.has(id),
        inScope: inScope.has(id),
        currentSourceFp: currentSourceFp.get(id) ?? null,
      });
      if (reason) {
        exclusions[reason] = (exclusions[reason] ?? 0) + 1;
        continue;
      }
      cand.source_fp = currentSourceFp.get(id) ?? null;
      if (selected.length < limit) selected.push(cand);
      else remainingEligible++;
    }

    if (!selected.length) {
      return json({
        ok: true,
        dry_run: dryRun,
        attempted: 0,
        scanned,
        remaining: 0,
        remaining_exact: remainingExact,
        exclusions,
        progress_marker: await progressMarker(),
        pipeline_run_id: pipelineRunId,
        zero_novelty: true,
        note: "no_reusable_photo_sources",
      });
    }

    // Marcatura ATOMICA prima di lavorare: anche no-photo/undecodable avanzano.
    if (!dryRun) {
      const ids = selected.map((c) => c.listing_id);
      const { error: markErr } = await sb
        .from("civiko_image_certify_attempts")
        .upsert(
          selected.map((c) => ({
            listing_id: c.listing_id,
            attempts: (attemptState.get(c.listing_id)?.attempts ?? 0) + 1,
            last_pipeline_run_id: pipelineRunId,
            last_outcome: "claimed",
            last_attempt_at: runStartedAt,
            // Il claim riapre il tentativo: lo stato terminale si ricalcola.
            terminal: false,
            terminal_reason: null,
          })),
          { onConflict: "listing_id" },
        );
      if (markErr) {
        return json({ ok: false, error: "attempts_progress_write_failed", detail: markErr.message }, 500);
      }
      if (ids.length > MAX_ATTEMPTS_PER_LISTING) {
        return json({ ok: false, error: "hard_limit_violated" }, 500);
      }
    }
  }

  // ── Fingerprint già persistiti (pairs_only: paginazione COMPLETA) ────────
  let listingIds: number[] = selected.map((c) => c.listing_id);
  let storedFingerprints: Fp[] = [];
  if (pairsOnly) {
    for (let page = 0; page < FINGERPRINT_MAX_PAGES; page++) {
      const from = page * FINGERPRINT_PAGE_SIZE;
      const { data: fps, error: fErr } = await sb
        .from("civiko_listing_image_fingerprints")
        .select("listing_id,sha256,phash,width,height,bytes,entropy,algo,source_host")
        .order("listing_id", { ascending: true })
        .order("sha256", { ascending: true })
        .range(from, from + FINGERPRINT_PAGE_SIZE - 1);
      if (fErr) {
        return json({ ok: false, error: "fingerprints_read_failed", detail: fErr.message }, 500);
      }
      const rows = fps ?? [];
      for (const f of rows) {
        storedFingerprints.push({
          listing_id: Number(f.listing_id),
          sha256: f.sha256 as string,
          phash: f.phash as string,
          width: Number(f.width),
          height: Number(f.height),
          bytes: Number(f.bytes),
          entropy: Number(f.entropy),
          algo: f.algo as string,
          source_host: (f.source_host as string) ?? "",
        });
      }
      if (rows.length < FINGERPRINT_PAGE_SIZE) break;
      if (page === FINGERPRINT_MAX_PAGES - 1) {
        return json({ ok: false, error: "fingerprints_pagination_overflow" }, 500);
      }
    }
    listingIds = Array.from(new Set(storedFingerprints.map((f) => f.listing_id)));
    if (!listingIds.length) {
      return json({ ok: true, pairs_only: true, zero_novelty: true, note: "no_fingerprints" });
    }
  }

  const { data: listings, error: lErr } = await sb
    .from("padova_listings")
    .select("id,url,fonte,agency,commercial_zone_slug,ev_via_norm,ev_image_refs")
    .in("id", listingIds);
  if (lErr) return json({ ok: false, error: "listings_read_failed", detail: lErr.message }, 500);
  const listingById = new Map((listings ?? []).map((l) => [Number(l.id), l]));

  // ── Estrazione multi-foto + fingerprint sui byte reali ──────────────────
  let reprocessed = 0;
  let refsTotal = 0;
  let decoded = 0;
  let undecodable = 0;
  let downloadFailed = 0;
  let rejectedQuality = 0;
  let rawJsonProcessed = 0;
  let rawJsonRefs = 0;
  const fingerprints: Fp[] = pairsOnly ? storedFingerprints : [];
  const outcomeByListing = new Map<number, string>();

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

  if (!pairsOnly) {
    // Detail memorizzati per i candidati selezionati (una sola lettura).
    const queueIds = selected
      .filter((c) => c.source === "evidence" && c.queue_id)
      .map((c) => c.queue_id!);
    const resultById = new Map<string, unknown>();
    if (queueIds.length) {
      const { data: queueRows, error: qErr } = await sb
        .from("scraping_queue")
        .select("id,result")
        .in("id", queueIds);
      if (qErr) return json({ ok: false, error: "queue_read_failed", detail: qErr.message }, 500);
      for (const r of queueRows ?? []) resultById.set(r.id as string, r.result);
    }

    const rawJsonIds = selected.filter((c) => c.source === "raw_json").map((c) => c.listing_id);
    const rawJsonById = new Map<number, Record<string, unknown> | null>();
    if (rawJsonIds.length) {
      const { data: rj, error: rjErr } = await sb
        .from("padova_listings")
        .select("id,raw_json")
        .in("id", rawJsonIds);
      if (rjErr) {
        return json({ ok: false, error: "raw_json_read_failed", detail: rjErr.message }, 500);
      }
      for (const r of rj ?? []) {
        rawJsonById.set(Number(r.id), (r.raw_json ?? null) as Record<string, unknown> | null);
      }
    }

    for (const cand of selected) {
      const listingId = cand.listing_id;
      if (!listingById.has(listingId)) {
        outcomeByListing.set(listingId, "listing_missing");
        continue;
      }
      let refs: string[] = [];
      if (cand.source === "evidence") {
        const result = cand.queue_id ? resultById.get(cand.queue_id) : null;
        if (result) {
          refs = extractDetailImageRefs(result, MAX_DETAIL_IMAGE_REFS);
          reprocessed++;
        }
      } else {
        const media = (rawJsonById.get(listingId)?.media ?? null) as Record<string, unknown> | null;
        const images = media?.images ?? null;
        if (images) {
          refs = extractDetailImageRefs(images, MAX_DETAIL_IMAGE_REFS);
          rawJsonProcessed++;
          rawJsonRefs += refs.length;
        }
      }
      refsTotal += refs.length;
      if (!refs.length) {
        outcomeByListing.set(listingId, "no_photo");
        continue;
      }

      if (!dryRun) {
        const { error: refErr } = await sb
          .from("padova_listings")
          .update({ ev_image_refs: refs })
          .eq("id", listingId);
        if (refErr) {
          return json({ ok: false, error: "image_refs_write_failed", detail: refErr.message }, 500);
        }
        if (cand.source === "evidence") {
          const { error: attErr } = await sb
            .from("civiko_contendibili_evidence_attempts")
            .update({
              evidence: { image_refs: refs, image_refs_version: "civiko-image-refs-v2" },
              updated_at: new Date().toISOString(),
            })
            .eq("listing_id", listingId);
          if (attErr) {
            return json({ ok: false, error: "evidence_write_failed", detail: attErr.message }, 500);
          }
        }
      }

      const before = fingerprints.length;
      await ingestRefs(listingId, refs);
      outcomeByListing.set(
        listingId,
        fingerprints.length > before ? "fingerprinted" : "undecodable",
      );
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

  // Persistenza idempotente dei fingerprint (errore = fail-closed).
  if (!dryRun && !pairsOnly && usable.length) {
    const { error } = await sb
      .from("civiko_listing_image_fingerprints")
      .upsert(
        usable.map((f) => ({ ...f, updated_at: new Date().toISOString() })),
        { onConflict: "listing_id,sha256" },
      );
    if (error) {
      return json({ ok: false, error: "fingerprints_write_failed", detail: error.message }, 500);
    }
  }

  // Esito definitivo dell'avanzamento (il claim resta comunque registrato).
  if (!dryRun && !pairsOnly && selected.length) {
    for (const cand of selected) {
      const { error } = await sb
        .from("civiko_image_certify_attempts")
        .update({ last_outcome: outcomeByListing.get(cand.listing_id) ?? "no_photo" })
        .eq("listing_id", cand.listing_id);
      if (error) {
        return json({ ok: false, error: "attempts_progress_write_failed", detail: error.message }, 500);
      }
    }
  }

  // ── Prove per coppia cross-agenzia ──────────────────────────────────────
  const byListing = new Map<number, Fp[]>();
  for (const f of usable) {
    const arr = byListing.get(f.listing_id) ?? [];
    arr.push(f);
    byListing.set(f.listing_id, arr);
  }
  const eligiblePairs = Array.from(byListing.entries())
    .filter(([, v]) => v.length >= MIN_SHARED_PHOTOS_PER_PAIR);
  const withTwoFingerprints = eligiblePairs.length;

  // Identità canonica: due righe che sono lo STESSO annuncio di portale non
  // possono mai costituire prova di contendibilità. Errore RPC = fail-closed.
  const canonicalById = new Map<number, string>();
  for (const [id] of eligiblePairs) {
    const l = listingById.get(id);
    const url = (l?.url as string | undefined) ?? "";
    if (!url) continue;
    const { data: canon, error: canonErr } = await sb.rpc("padova_listing_canonical_id", {
      p_url: url,
      p_fonte: (l?.fonte as string | null) ?? null,
    });
    if (canonErr) {
      return json({ ok: false, error: "canonical_id_failed", detail: canonErr.message }, 500);
    }
    if (typeof canon === "string" && canon) canonicalById.set(id, canon);
  }
  let scartatiStessoAnnuncio = 0;

  const pairRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < eligiblePairs.length; i++) {
    for (let j = i + 1; j < eligiblePairs.length; j++) {
      const [idA] = eligiblePairs[i];
      const [idB] = eligiblePairs[j];
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
        computed_at: runStartedAt,
        updated_at: runStartedAt,
      });
    }
  }

  let stalePairsRemoved = 0;
  if (!dryRun && pairRows.length) {
    const { error } = await sb
      .from("civiko_listing_photo_pair_evidence")
      .upsert(pairRows, { onConflict: "listing_a,listing_b" });
    if (error) return json({ ok: false, error: "pairs_write_failed", detail: error.message }, 500);
  }
  if (!dryRun && pairsOnly) {
    // Sostituzione atomica: pairs_only ha ricalcolato TUTTO l'insieme, quindi
    // ogni prova non riscritta in questo giro è stantia e va rimossa.
    const { data: removed, error } = await sb
      .from("civiko_listing_photo_pair_evidence")
      .delete()
      .lt("computed_at", runStartedAt)
      .select("listing_a");
    if (error) return json({ ok: false, error: "stale_pairs_delete_failed", detail: error.message }, 500);
    stalePairsRemoved = (removed ?? []).length;
  }

  return json({
    ok: true,
    dry_run: dryRun,
    pairs_only: pairsOnly,
    // Avanzamento monotono indipendente da offset e id di coda.
    progress_marker: await progressMarker(),
    attempted: listingIds.length,
    scanned,
    remaining: pairsOnly ? 0 : Math.max(0, poolSize - selected.length),
    pipeline_run_id: pipelineRunId,
    limit,
    zone_scope: zoneScope,
    max_attempts_per_listing: MAX_ATTEMPTS_PER_LISTING,
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
    coppie_stantie_rimosse: stalePairsRemoved,
    coppie_certificanti:
      pairRows.filter((p) => (p.shared_photos as number) >= MIN_SHARED_PHOTOS_PER_PAIR).length,
    budget_richieste_usate: budget.used,
    diagnostics,
  });
});
