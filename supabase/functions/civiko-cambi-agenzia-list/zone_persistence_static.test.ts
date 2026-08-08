// Regressione statica — G19: commercial_zone_slug persistito sui cambi agenzia
// (migrazione 20260806192548) + contratto autorevole dell'endpoint di lista.
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION =
  "supabase/migrations/20260806192548_3ee17e1b-0c0f-45b3-acaf-017f8ac0f6f6.sql";

const sql = await Deno.readTextFile(MIGRATION);
const endpoint = await Deno.readTextFile(
  "supabase/functions/civiko-cambi-agenzia-list/index.ts",
);

const OFFICIAL = [
  "centro-storico",
  "est-brenta",
  "nord-est",
  "nord-arcella",
  "ovest-chiesanuova-brentelle",
  "sud-est-sant-osvaldo",
  "sud-ovest-mandria",
  "sud-voltabarozzo-guizza",
];

Deno.test("campo zona persistito, non ricalcolato per lettura", () => {
  assert(
    /ALTER TABLE public\.padova_cambi_agenzia[\s\S]{0,80}ADD COLUMN IF NOT EXISTS commercial_zone_slug text/
      .test(sql),
    "colonna persistita assente",
  );
  const view = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW public.padova_cambi_agenzia_by_zone_v"));
  const viewBody = view.slice(0, view.indexOf("-- Patch fail-closed"));
  assert(
    !/civiko_resolve_commercial_zone_slug/.test(viewBody),
    "la vista non puo' ricalcolare la zona a ogni lettura",
  );
  assert(/commercial_zone_slug\s*\n\s*FROM public\.padova_cambi_agenzia/.test(viewBody));
});

Deno.test("risoluzione autorevole: annuncio corrispondente, poi risolutore ufficiale", () => {
  const fn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.civiko_cambi_zone_slug"),
    sql.indexOf("REVOKE ALL ON FUNCTION public.civiko_cambi_zone_slug"),
  );
  assert(/FROM public\.padova_listings p/.test(fn), "priorita' all'annuncio corrispondente");
  assert(/public\.canon_url\(p\.url\) = _curl/.test(fn), "correlazione via canonical URL");
  assert(/civiko_resolve_commercial_zone_slug\(_quartiere\)/.test(fn), "fallback risolutore ufficiale");
  for (const slug of OFFICIAL) assert(fn.includes(`'${slug}'`), `zona ufficiale mancante: ${slug}`);
});

Deno.test("il rilevatore scrive la zona anche negli aggiornamenti futuri", () => {
  const patch = sql.slice(sql.indexOf("DO $patch$"), sql.indexOf("DO $verify$"));
  assert(/contendibile_overlap, commercial_zone_slug/.test(patch), "INSERT senza la colonna zona");
  assert(/public\.civiko_cambi_zone_slug\(ch\.curl, s\.quartiere\)/.test(patch), "proiezione assente");
  assert(
    /commercial_zone_slug = COALESCE\(EXCLUDED\.commercial_zone_slug,\s*\n\s*pca\.commercial_zone_slug\)/
      .test(patch),
    "ON CONFLICT non aggiorna la zona",
  );
  for (const guard of ["patch: elenco colonne INSERT atteso non trovato", "patch: nessuna modifica applicata"]) {
    assert(patch.includes(guard), `guardia fail-closed mancante: ${guard}`);
  }
});

Deno.test("endpoint: isolamento zona nel database, mai in memoria", () => {
  assert(/requireSecret\(req, did\)/.test(endpoint), "segreto verificato prima del DB");
  const secretIdx = endpoint.indexOf("requireSecret(req, did)");
  assert(endpoint.indexOf("createClient(") > secretIdx, "client DB creato prima del controllo segreto");
  assert(/x-workspace-id/.test(endpoint), "workspace solo da header");
  assert(!/req\.json\(\)/.test(endpoint), "nessuna identita' dal body");
  assert(/out\.in\("commercial_zone_slug", scope\.slugs\)/.test(endpoint), "filtro zona non nel DB");
  assert(!/ilike/i.test(endpoint), "nessun ILIKE su input utente");
  assert(/SLUG_OUT_OF_CONTRACT/.test(endpoint), "slug fuori contratto non rifiutato");
});

Deno.test("endpoint: EOF, totale esatto e nessun placeholder", () => {
  assert(/count: "exact", head: true/.test(endpoint), "totale globale non esatto");
  assert(/if \(!page\.beyond_eof\)/.test(endpoint), "offset oltre il totale deve dare items vuoti");
  assert(/snapshotComplete\(\{ countExact, truncated: false \}\)/.test(endpoint));
  assert(/titolo: nullableText\(r\.titolo\)/.test(endpoint), "titolo assente deve restare null");
  assert(/indirizzo: nullableText\(r\.indirizzo\)/.test(endpoint), "indirizzo assente deve restare null");
});
