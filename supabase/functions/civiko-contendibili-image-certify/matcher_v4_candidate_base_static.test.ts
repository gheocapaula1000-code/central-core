// Regressione statica — forward repair E10/E11/E12/E14 (migrazione 20260806192349).
// Prova che la BASE CANDIDATI non impone piu' alcun veto globale di metadata e
// che quei vincoli vivono esclusivamente nel ramo strutturale.
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION =
  "supabase/migrations/20260806192349_0735b3dc-9a1e-4534-9ed1-da26f7f34f29.sql";

const sql = await Deno.readTextFile(MIGRATION);

function section(from: string, to: string): string {
  const a = sql.indexOf(from);
  assert(a > -1, `sezione non trovata: ${from}`);
  const b = sql.indexOf(to, a);
  assert(b > -1, `fine sezione non trovata: ${to}`);
  return sql.slice(a, b);
}

const candidates = section(
  "CREATE FUNCTION public.civiko_padova_matcher_v4_candidates()",
  "CREATE FUNCTION public.civiko_padova_matcher_v4_pairs()",
);
const pairs = section(
  "CREATE FUNCTION public.civiko_padova_matcher_v4_pairs()",
  "-- ── PATCH FAIL-CLOSED",
);

Deno.test("candidati: nessun veto globale mq/locali/keyword titolo", () => {
  const where = candidates.slice(candidates.indexOf("FROM public.padova_listings p"));
  assert(!/p\.mq IS NOT NULL AND p\.mq > 0/.test(where), "mq resta un veto globale");
  assert(!/AND p\.locali IS NOT NULL/.test(where), "locali resta un veto globale");
  // La keyword del titolo puo' esistere solo come colonna derivata, mai in WHERE.
  const whereClause = where.slice(where.indexOf("WHERE"), where.indexOf("filtered AS"));
  assert(!/~ '\(appartament/.test(whereClause), "keyword titolo usata come veto globale");
  assert(/AS title_type_ok/.test(candidates), "title_type_ok deve essere esposta");
});

Deno.test("candidati: perimetro minimo esatto e letterale", () => {
  assert(/p\.expired_at IS NULL/.test(candidates), "solo annunci attivi");
  assert(/p\.comune = 'Padova'/.test(candidates), "Comune Padova esatto");
  assert(/p\.commercial_zone_slug IN \(/.test(candidates), "slug persistito richiesto");
  assert(/p\.prezzo IS NOT NULL AND p\.prezzo > 0/.test(candidates), "prezzo obbligatorio");
  assert(/is_asta IS NOT TRUE/.test(candidates) && /is_mls IS NOT TRUE/.test(candidates));
});

// Il perimetro zone non e' piu' una lista letterale: dal contratto territoriale
// definitivo (8 zone, nord-est al posto di est-forcellini-camin) vive nella
// funzione centrale public.civiko_is_official_zone_slug.
Deno.test("candidati: perimetro zone delegato al contratto centrale 8 zone", async () => {
  const contract = await Deno.readTextFile(
    "supabase/migrations/20260808122007_193ef8fb-e75b-476e-97c7-7fdb81d0c7fb.sql",
  );
  assert(
    /civiko_is_official_zone_slug\(p\.commercial_zone_slug\)/.test(contract),
    "i candidati devono usare il contratto centrale delle zone ufficiali",
  );
  assert(
    !/est-forcellini-camin/.test(contract),
    "la zona legacy non puo' rientrare nel perimetro",
  );
});


Deno.test("ramo strutturale: porta interamente i vincoli di metadata", () => {
  const structural = pairs.slice(pairs.indexOf("structural_edges AS ("), pairs.indexOf("unioned AS ("));
  for (
    const req of [
      "(b.x).title_type_ok IS TRUE AND (b.y).title_type_ok IS TRUE",
      "(b.x).locali IS NOT NULL AND (b.y).locali IS NOT NULL",
      "(b.x).mq IS NOT NULL AND (b.y).mq IS NOT NULL",
      "(b.x).tipologia = (b.y).tipologia",
      "(b.x).piano_k = (b.y).piano_k",
    ]
  ) {
    assert(structural.includes(req), `vincolo strutturale mancante: ${req}`);
  }
});

Deno.test("ramo foto: nessun requisito obbligatorio di metadata", () => {
  const photo = pairs.slice(pairs.indexOf("photo_edges AS ("), pairs.indexOf("structural_edges AS ("));
  assert(!/title_type_ok/.test(photo), "il ramo foto non puo' richiedere la keyword titolo");
  assert(!/IS NOT NULL AND \(b\.y\)\.(mq|locali|piano_k|tipologia) IS NOT NULL/.test(photo));
  // I segnali di plausibilita' sono alternativi (OR), mai congiunti.
  assert(/prezzo_ratio <= 1\.10[\s\S]{0,120}shared_photos >= 1/.test(photo), "banda <=10% con >=1 foto");
  assert(
    /prezzo_ratio > 1\.10 AND b\.prezzo_ratio <= 1\.15 AND pe\.shared_photos >= 2/.test(photo),
    "banda 10-15% con >=2 foto",
  );
  assert(/m\.prezzo_ratio <= 1\.15;/.test(pairs), ">15% sempre rifiutato");
});

Deno.test("clique miste etichettate MIXED_V4, mai IMAGE_PHASH puro", () => {
  const patch = sql.slice(sql.indexOf("-- ── PATCH FAIL-CLOSED"));
  assert(/'MIXED_V4'/.test(patch), "etichetta MIXED_V4 assente");
  assert(
    /coalesce\(f\.n_pairs_photo,0\) = coalesce\(f\.n_pairs,0\)[\s\S]{0,80}'IMAGE_PHASH_V1'/.test(patch),
    "IMAGE_PHASH_V1 solo se ogni coppia e' fotografica",
  );
  assert(
    /coalesce\(f\.n_pairs_photo,0\) = 0 THEN 'UNIT_GEO_TEXT_V4'/.test(patch),
    "STRUCTURAL solo con zero coppie fotografiche",
  );
  assert(/'UNIT_GEO_TEXT_V4', 'MIXED_V4'/.test(patch), "QA post-scrittura deve coprire MIXED_V4");
});

Deno.test("verifica fail-closed e regressioni note nella migrazione", () => {
  const verify = sql.slice(sql.indexOf("DO $verify$"));
  assert(/RAISE EXCEPTION 'verifica: veto globale metadata/.test(verify));
  assert(/\(2309, 60498\)/.test(verify) && /\(3619, 60735\)/.test(verify), "negativi duri assenti");
  assert(/44787/.test(verify) && /101390/.test(verify), "positivo noto assente");
  assert(
    /RAISE EXCEPTION 'regressione: coppia positiva 44787\/101390/.test(verify),
    "il positivo deve fallire chiuso quando i prerequisiti v4 esistono",
  );
});
