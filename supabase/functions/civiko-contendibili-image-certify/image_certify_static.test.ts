// Test statici: contratto deterministico della certificazione fotografica.
// Nessuna chiamata live, nessun provider: si verifica il SORGENTE.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SRC = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const BUDGET = await Deno.readTextFile(new URL("./invokeBudget.ts", import.meta.url));

Deno.test("nessun cursore after_listing_id: la coda muta e bloccherebbe", () => {
  assert(!SRC.includes("after_listing_id"), "il cursore after_listing_id deve essere rimosso");
});

Deno.test("tetto TOTALE di 4 listing unici, mai 4+4", () => {
  assertStringIncludes(BUDGET, "TOTAL_LISTINGS_PER_INVOCATION = 4");
  assertStringIncludes(SRC, "TOTAL_LISTINGS_PER_INVOCATION");
  const limitCalls = SRC.match(/\.limit\(limit\)/g) ?? [];
  assertEquals(limitCalls.length, 0, "il limite non va applicato per singola fonte");
  assertStringIncludes(SRC, "selectEligible(");
  assertStringIncludes(SRC, "outcome.selected");
});

Deno.test("hard max 4 tentativi per listing", () => {
  assertStringIncludes(SRC, "MAX_ATTEMPTS_PER_LISTING = 4");
  assertStringIncludes(SRC, "maxAttempts: MAX_ATTEMPTS_PER_LISTING");
  assertStringIncludes(SRC, "attempts ?? 0) < MAX_ATTEMPTS_PER_LISTING");
});

Deno.test("marcatura per listing prima della lavorazione (no-photo incluso)", () => {
  const markIdx = SRC.indexOf('last_outcome: "claimed"');
  const ingestIdx = SRC.indexOf("await ingestRefs(");
  assert(markIdx > 0 && ingestIdx > 0 && markIdx < ingestIdx, "il claim deve precedere il lavoro");
  assertStringIncludes(SRC, 'last_outcome: "claimed"');
  assertStringIncludes(SRC, '"no_photo"');
});

Deno.test("wall-clock 100s: i non lavorati non diventano terminali fasulli", () => {
  assertStringIncludes(SRC, "wallClockExceeded");
  assertStringIncludes(SRC, "INVOKE_WALL_MS");
  assertStringIncludes(SRC, "if (!rawOutcome) continue");
  assertStringIncludes(SRC, "wall_clock_deferred");
});

Deno.test("auto-catena limitata: chain true, cooldown 2s, si ferma senza lavoro", () => {
  assertStringIncludes(SRC, "shouldChainNext");
  assertStringIncludes(SRC, "CHAIN_COOLDOWN_MS");
  assertStringIncludes(SRC, "CHAIN_MAX_HOPS");
  assertStringIncludes(SRC, "enqueueChain");
});

Deno.test("listing già fingerprintati non bloccano la coda", () => {
  assertStringIncludes(SRC, "for (const r of data ?? []) fingerprinted.add(Number(r.listing_id));");
  assertStringIncludes(SRC, "hasFingerprint: fingerprinted.has(cand.listing_id)");
});

Deno.test("progress marker monotono non basato su offset/id", () => {
  assertStringIncludes(SRC, "progress_marker: await progressMarker()");
  assert(!/progress_marker:\s*(offset|from|listingIds\[)/.test(SRC));
});

Deno.test("perimetro esatto Padova + 8 zone", () => {
  const zones = SRC.match(/CIVIKO_ZONE_SLUGS = \[([\s\S]*?)\] as const/);
  assert(zones, "elenco zone assente");
  const count = (zones![1].match(/"/g) ?? []).length / 2;
  assertEquals(count, 8);
  assertStringIncludes(SRC, '.eq("comune", "Padova")');
  assertStringIncludes(SRC, '.in("commercial_zone_slug", zoneScope)');
});

Deno.test("pairs_only pagina TUTTI i fingerprint: nessun limit 5000", () => {
  assert(!SRC.includes(".limit(5000)"), "vietato il tetto arbitrario 5000 sui fingerprint");
  assertStringIncludes(SRC, "FINGERPRINT_PAGE_SIZE");
  assertStringIncludes(SRC, "fingerprints_pagination_overflow");
});

Deno.test("errore RPC canonica = fail-closed", () => {
  assertStringIncludes(SRC, 'error: "canonical_id_failed"');
  assertStringIncludes(SRC, "if (canonErr)");
});

Deno.test("coppie stantie sostituite atomicamente in una sola transazione", () => {
  assertStringIncludes(SRC, 'sb.rpc("civiko_replace_photo_pair_evidence"');
  assertStringIncludes(SRC, "p_computed_at: runStartedAt");
  assertStringIncludes(SRC, "stale_deleted");
  assert(
    !SRC.includes('.lt("computed_at", runStartedAt)'),
    "nessuna delete separata: la sostituzione deve restare atomica",
  );
});

Deno.test("coppie identity: zona + mq + prezzo, non via/civico", () => {
  assertStringIncludes(SRC, '.select("id,url,fonte,agency,commercial_zone_slug,mq,prezzo,ev_image_refs")');
  assertStringIncludes(SRC, "Via/civico are NOT");
  assertStringIncludes(SRC, "Math.max(mqLo + 5, mqLo * 1.05)");
  assertStringIncludes(SRC, "prezzoHi > prezzoLo * 1.15");
  assert(!SRC.includes("ev_via_norm"), "via non e' un gate delle coppie foto");
  assert(!SRC.includes("ev_civico_norm"), "civico non e' un gate delle coppie foto");
});

Deno.test("fonte B legge Casa raw_json.image e ev_image_refs, non solo media.images", () => {
  assertStringIncludes(SRC, "LISTING_PHOTO_SOURCE_OR");
  assertStringIncludes(SRC, "listingPhotoSource");
  assertStringIncludes(SRC, "listingImageSourceInput");
  assertStringIncludes(SRC, '.select("id,ev_image_refs,raw_json")');
  assert(
    !SRC.includes('.not("raw_json->media->images", "is", null)'),
    "il pool non puo' restare chiuso su solo media.images",
  );
});

Deno.test("un publish vuoto di fingerprint/coppie non e' successo", () => {
  assertStringIncludes(SRC, 'error: "photo_sources_not_fingerprinted"');
  assertStringIncludes(SRC, 'error: "no_fingerprints"');
  assertStringIncludes(SRC, "identity_starved: true");
  assertStringIncludes(SRC, "empty_fingerprint_publish_is_not_success");
  assert(
    !/ok:\s*true[\s\S]{0,200}note:\s*"no_reusable_photo_sources"/.test(SRC),
    "no_reusable_photo_sources non puo' tornare ok:true",
  );
});

Deno.test("ogni scrittura critica controlla l'errore", () => {
  for (
    const marker of [
      "image_refs_write_failed",
      "evidence_write_failed",
      "fingerprints_write_failed",
      "attempts_progress_write_failed",
      "pairs_write_failed",
    ]
  ) {
    assertStringIncludes(SRC, marker);
  }
});
