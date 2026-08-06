// Regressione statica — Civiko One / Padova, matcher contendibili v4.
// Contratto propagato PER OGNI EDGE fino al gruppo/certificazione:
// - rami photo_edges e structural_edges separati e poi UNION;
// - il ramo foto NON puo' imporre piano/tipologia/locali/mq/bagni/civico;
// - la stessa identita' immobiliare fra agenzie diverse NON e' un veto;
// - reject comuni: stessa canonical, stessa agenzia, asta/MLS, fuori zona,
//   scarto prezzo oltre il 15%;
// - il gate di gruppo e' complete-link e branch-aware (i vincoli di metadata
//   valgono solo per i gruppi interamente strutturali).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION =
  "supabase/migrations/20260806181048_9f50aafc-7278-4e4c-8bc6-11beaf0b8153.sql";

async function readMigration(): Promise<string> {
  return await Deno.readTextFile(MIGRATION);
}

function pairsFunctionBody(sql: string): string {
  const start = sql.indexOf("$function$");
  const end = sql.indexOf("$function$", start + 1);
  assert(start > -1 && end > start, "corpo di civiko_padova_matcher_v4_pairs non trovato");
  return sql.slice(start, end);
}

function groupBlock(sql: string): string {
  const start = sql.indexOf("$blk$");
  const end = sql.indexOf("$blk$", start + 1);
  assert(start > -1 && end > start, "blocco gruppo/QA branch-aware non trovato");
  return sql.slice(start, end);
}

function branch(body: string, name: string): string {
  const start = body.indexOf(`${name} AS (`);
  assert(start > -1, `ramo ${name} assente`);
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

Deno.test("matcher v4: il ramo foto non impone piano/bagni come requisito", async () => {
  const photo = branch(pairsFunctionBody(await readMigration()), "photo_edges");
  for (const forbidden of ["piano_k", "bagni"]) {
    assert(
      !new RegExp(forbidden).test(photo),
      `requisito ${forbidden} vietato nel ramo fotografico`,
    );
  }
  // tipologia/locali/mq/civico compaiono solo come segnali alternativi di
  // plausibilita' (OR), mai come requisito congiunto.
  assert(!/AND \(b\.x\)\.tipologia = /.test(photo), "tipologia non puo' essere obbligatoria");
  assert(!/AND \(b\.x\)\.locali = /.test(photo), "locali non puo' essere obbligatorio");
  assert(
    /shared_photos >= 2/.test(photo),
    "la fascia 10-15% deve accettare 2 pHash condivisi come prova forte",
  );
  assert(/shared_photos >= 1/.test(photo), "la fascia <=10% richiede almeno 1 pHash");
  assert(
    /prezzo_ratio <= 1\.10[\s\S]*shared_photos >= 1[\s\S]*OR/.test(photo),
    "la fascia <=10% richiede 1 pHash piu' almeno un segnale di plausibilita'",
  );
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
  assert(
    /x\.is_asta IS NOT TRUE AND y\.is_asta IS NOT TRUE/.test(body),
    "asta esclusa in ogni ramo",
  );
  assert(
    /x\.is_mls IS NOT TRUE AND y\.is_mls IS NOT TRUE/.test(body),
    "MLS/esclusiva esclusa in ogni ramo",
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

Deno.test("matcher v4: ogni edge espone il proprio ramo di prova", async () => {
  const body = pairsFunctionBody(await readMigration());
  assert(/evidence_branch text/.test(body) || /evidence_branch/.test(body));
  assert(/'PHOTO'::text AS evidence_branch/.test(body), "ramo PHOTO esplicito");
  assert(/'STRUCTURAL'::text AS evidence_branch/.test(body), "ramo STRUCTURAL esplicito");
  assert(/photo_strong/.test(body), "il flag photo_strong deve essere propagato");
});

Deno.test("gate di gruppo: complete-link senza transitivita'", async () => {
  const blk = groupBlock(await readMigration());
  assert(/_photo_cliques/.test(blk), "manca la costruzione delle clique");
  assert(/n_pairs = g\.n_pairs_attese/.test(blk), "complete-link obbligatorio");
  assert(/n_rows BETWEEN 2 AND 4/.test(blk), "gruppi da 2 a 4 annunci");
  assert(
    /JOIN _pe p3 ON p3\.a_id = p1\.b_id AND p3\.b_id = p2\.b_id/.test(blk),
    "la clique da 3 deve richiedere anche l'edge A-C",
  );
});

Deno.test("gate di gruppo: metadata solo per gruppi interamente strutturali", async () => {
  const blk = groupBlock(await readMigration());
  assert(
    /g\.n_pairs_photo > 0\s*\n\s*OR \(/.test(blk),
    "i gruppi con prova fotografica devono bypassare i vincoli di metadata",
  );
  assert(
    /coalesce\(n_pairs_photo, 0\) = 0\s*\n\s*AND \(/.test(blk),
    "la QA applica i vincoli di metadata solo ai gruppi strutturali",
  );
  assert(/n_pairs_over15, 0\) > 0/.test(blk), "nessuna coppia oltre il 15% nel gruppo");
  assert(/n_pairs_photo_weak, 0\) > 0/.test(blk), "nessuna prova fotografica debole");
  assert(/has_asta IS TRUE/.test(blk), "asta rifiutata a livello gruppo");
  assert(/has_mls IS TRUE/.test(blk), "MLS rifiutato a livello gruppo");
  assert(/n_agenzie >= 2/.test(blk), "gruppo cross-agency obbligatorio");
  assert(/n_annunci_canonici >= 2/.test(blk), "canonical distinti obbligatori");
});

Deno.test("regression fixture: negativi noti mai riammessi", async () => {
  const sql = await readMigration();
  assert(/\(2309, 60498\), \(3619, 60735\)/.test(sql), "fixture negativi assenti");
  assert(/\(44787, 101390\)/.test(sql), "fixture positivi assenti");
  assert(
    /Regressione matcher: % coppie negative note riammesse/.test(sql),
    "la fixture negativa deve essere fail-closed",
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
