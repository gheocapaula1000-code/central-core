// Regressione statica — Civiko One / Padova, matcher contendibili v4.
// Vieta il ritorno di un prerequisito fotografico globale nella generazione
// delle coppie: le evidenze foto devono restare SEMPRE in LEFT JOIN.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION =
  "supabase/migrations/20260806171252_cdd7c443-9c47-4014-a9a3-9b44babf1eae.sql";

async function readMigration(): Promise<string> {
  return await Deno.readTextFile(MIGRATION);
}

function pairsFunctionBody(sql: string): string {
  const start = sql.indexOf("$fn_pairs$");
  const end = sql.indexOf("$fn_pairs$", start + 1);
  assert(start > -1 && end > start, "corpo di civiko_padova_matcher_v4_pairs non trovato");
  return sql.slice(start, end);
}

Deno.test("matcher v4: evidenze fotografiche solo in LEFT JOIN", async () => {
  const body = pairsFunctionBody(await readMigration());
  const joins = [...body.matchAll(/(\w+\s+)?JOIN\s+public\.civiko_listing_photo_pair_evidence/gi)];
  assert(joins.length > 0, "nessun join alle evidenze fotografiche trovato");
  for (const j of joins) {
    assertEquals(
      (j[1] ?? "").trim().toUpperCase(),
      "LEFT",
      `INNER JOIN vietato sulle evidenze fotografiche: ${j[0]}`,
    );
  }
});

Deno.test("matcher v4: nessun prerequisito globale foto >= 1", async () => {
  const body = pairsFunctionBody(await readMigration());
  assert(
    !/shared_photos\s*,\s*0\)\s*>=\s*1/i.test(body),
    "coalesce(shared_photos,0) >= 1 non è ammesso come prerequisito",
  );
  assert(
    !/shared_photos\s*>=\s*1/i.test(body),
    "shared_photos >= 1 non è ammesso come prerequisito globale",
  );
});

Deno.test("matcher v4: ramo geo+unità+testo indipendente dalle foto", async () => {
  const body = pairsFunctionBody(await readMigration());
  assert(/geo_unita_testo_ok/.test(body), "manca il flag geo_unita_testo_ok");
  assert(
    /shared_photos\s*>=\s*2\s*OR\s*p\.geo_unita_testo_ok/i.test(body.replace(/\s+/g, " ")),
    "la fascia 10-15% deve accettare geo+unità+testo in alternativa alle foto",
  );
  assert(/<= 1\.15/.test(body), "manca il tetto del 15%");
  assert(/<= 1\.10/.test(body), "manca la fascia strutturale del 10%");
});

Deno.test("matcher v4: candidati limitati alle 8 zone ufficiali e senza asta/MLS", async () => {
  const sql = await readMigration();
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
