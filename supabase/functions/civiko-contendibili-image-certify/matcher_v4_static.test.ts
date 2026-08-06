// Regressione statica — Civiko One / Padova, matcher contendibili v4.
// Contratto: rami photo_edges e structural_edges separati e poi UNION.
// - Il ramo foto NON puo' imporre piano/tipologia/locali/mq/bagni.
// - La stessa identita' immobiliare fra agenzie diverse NON e' un veto.
// - Oltre il 15% di scarto prezzo nessuna coppia e' ammessa.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION =
  "supabase/migrations/20260806173226_5fe22790-0787-4a3d-95af-e8c58b0e5399.sql";

async function readMigration(): Promise<string> {
  return await Deno.readTextFile(MIGRATION);
}

function pairsFunctionBody(sql: string): string {
  const start = sql.indexOf("$fn_pairs$");
  const end = sql.indexOf("$fn_pairs$", start + 1);
  assert(start > -1 && end > start, "corpo di civiko_padova_matcher_v4_pairs non trovato");
  return sql.slice(start, end);
}

function branch(body: string, name: string): string {
  const start = body.indexOf(`${name} AS (`);
  assert(start > -1, `ramo ${name} assente`);
  // dal marcatore fino al ramo successivo di primo livello
  const rest = body.slice(start);
  const next = rest.slice(1).search(/\n  \w+ AS \(/);
  return next > -1 ? rest.slice(0, next + 1) : rest;
}

Deno.test("matcher v4: rami photo_edges e structural_edges separati e uniti", async () => {
  const body = pairsFunctionBody(await readMigration());
  assert(/photo_edges AS \(/.test(body), "manca il ramo photo_edges");
  assert(/structural_edges AS \(/.test(body), "manca il ramo structural_edges");
  assert(
    /SELECT \* FROM photo_edges\s+UNION ALL\s+SELECT \* FROM structural_edges/.test(body),
    "i due rami devono essere uniti con UNION ALL",
  );
});

Deno.test("matcher v4: il ramo foto non impone piano/tipologia/bagni", async () => {
  const photo = branch(pairsFunctionBody(await readMigration()), "photo_edges");
  for (const forbidden of ["piano_k", "tipologia", "bagni"]) {
    assert(
      !new RegExp(forbidden).test(photo),
      `requisito ${forbidden} vietato nel ramo fotografico`,
    );
  }
  assert(
    /shared_photos >= 2/.test(photo),
    "la fascia 10-15% deve accettare 2 pHash condivisi come prova forte",
  );
  assert(/shared_photos >= 1/.test(photo), "la fascia <=10% richiede almeno 1 pHash");
});

Deno.test("matcher v4: identita' immobiliare uguale non e' un veto", async () => {
  const body = pairsFunctionBody(await readMigration());
  assert(!/identity_key\s*<>/.test(body), "identity_key non puo' escludere coppie");
  assert(!/civico_n\s*<>/.test(body), "il civico non puo' essere un veto");
  assert(
    /agency_key <> x\.agency_key/.test(body),
    "la stessa agenzia deve restare esclusa",
  );
  assert(
    /canonical_listing_id <> x\.canonical_listing_id/.test(body),
    "la stessa canonical/ripubblicazione deve restare esclusa",
  );
});

Deno.test("matcher v4: il ramo strutturale mantiene unita' compatibile e geo+testo", async () => {
  const structural = branch(pairsFunctionBody(await readMigration()), "structural_edges");
  assert(/locali = \(b\.y\)\.locali/.test(structural), "unita': locali uguali");
  assert(/tipologia = \(b\.y\)\.tipologia/.test(structural), "unita': tipologia uguale");
  assert(/piano_k = \(b\.y\)\.piano_k/.test(structural), "unita': piano uguale");
  assert(/dist_m <= 30/.test(structural), "fascia 10-15% senza foto: geo <= 30 m");
  assert(/descr_fp = \(b\.y\)\.descr_fp/.test(structural), "fascia 10-15%: testo forte");
});

Deno.test("matcher v4: tetto assoluto del 15%", async () => {
  const body = pairsFunctionBody(await readMigration());
  assertEquals(/prezzo_ratio <= 1\.15/.test(body), true, "manca il tetto del 15%");
  assert(
    /WHERE m\.prezzo_ratio <= 1\.15/.test(body),
    "il tetto del 15% deve valere sull'output finale",
  );
});

Deno.test("matcher v4: candidati limitati alle 8 zone ufficiali e senza asta/MLS", async () => {
  const sql = await Deno.readTextFile(
    "supabase/migrations/20260806171252_cdd7c443-9c47-4014-a9a3-9b44babf1eae.sql",
  );
  const start = sql.indexOf("$fn_cand$");
  const end = sql.indexOf("$fn_cand$", start + 1);
  const body = sql.slice(start, end);
  assert(/civiko_commercial_zones/.test(body), "manca il vincolo sulle zone ufficiali");
  assert(/is_asta IS NOT TRUE/.test(body), "le aste devono essere escluse");
  assert(/is_mls IS NOT TRUE/.test(body), "gli incarichi MLS/esclusiva devono essere esclusi");
});

Deno.test("matcher v4: versione match esplicita", async () => {
  const body = pairsFunctionBody(await readMigration());
  assert(/'v4'::text AS match_version/.test(body), "match_version deve essere esplicita a v4");
});
