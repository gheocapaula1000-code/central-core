-- Paula: same agency ≠ conteso. Different houses ≠ conteso.
-- Live Core: jpunnzgixcghuydstdlt
--
-- 1) n_agenzie = distinct agencies AFTER agency_k3 alias collapse.
--    "Gabetti Padova Centro" and "Gabetti Centro" = ONE agency.
--    After collapse, n_agenzie < 2 must not publish.
-- 2) Shared pHash is MANDATORY. Structural-only pairs (0 shared photos)
--    are forbidden. No zone+price / address-only / price-only matches.
-- 3) Photo pairs still need the same house: (via+civico) OR dist_m <= 40,
--    and mq_max <= greatest(mq_min+5, mq_min*1.05).
--    Drop PHOTO OR-list and dist_m <= 150 free pass.
-- list >= 2, HOT display >= 3 (unchanged).

-- ── helpers: existing agency_k3 (first 3 alnum tokens) + collapse ─────────
CREATE OR REPLACE FUNCTION public.civiko_padova_agency_k3(p_agency text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $fn$
  SELECT string_agg(z.tok, '' ORDER BY z.rn)
    FROM (
      SELECT tok, row_number() OVER () AS rn
        FROM unnest(regexp_split_to_array(lower(coalesce(p_agency, '')), '[^a-z0-9]+')) AS tok
       WHERE tok <> ''
    ) z
   WHERE z.rn <= 3;
$fn$;

CREATE OR REPLACE FUNCTION public.civiko_padova_agency_collapse_key(p_agency text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $fn$
  -- Brand = first non-generic token of agency_k3. Generic prefixes
  -- (immobiliare / agenzia / studio) are skipped so "Immobiliare Rossi"
  -- and "Immobiliare Bianchi" stay distinct, while "Gabetti Padova Centro"
  -- and "Gabetti Centro" collapse to gabetti.
  SELECT COALESCE(
    (
      SELECT z.tok
        FROM (
          SELECT tok, row_number() OVER () AS rn
            FROM unnest(regexp_split_to_array(lower(coalesce(p_agency, '')), '[^a-z0-9]+')) AS tok
           WHERE tok <> ''
             AND tok NOT IN ('immobiliare', 'agenzia', 'studio', 'group', 'real', 'estate')
        ) z
       WHERE z.rn = 1
    ),
    public.civiko_padova_agency_k3(p_agency)
  );
$fn$;

CREATE OR REPLACE FUNCTION public.civiko_padova_agency_same_office(p_a text, p_b text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $fn$
  SELECT
    coalesce(ka, '') <> '' AND coalesce(kb, '') <> ''
    AND (
      ka = kb
      OR ka LIKE kb || '%'
      OR kb LIKE ka || '%'
      OR (coalesce(ca, '') <> '' AND ca = cb)
    )
  FROM (
    SELECT public.civiko_padova_agency_k3(p_a) AS ka,
           public.civiko_padova_agency_k3(p_b) AS kb,
           public.civiko_padova_agency_collapse_key(p_a) AS ca,
           public.civiko_padova_agency_collapse_key(p_b) AS cb
  ) s;
$fn$;

REVOKE ALL ON FUNCTION public.civiko_padova_agency_k3(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.civiko_padova_agency_collapse_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.civiko_padova_agency_same_office(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_padova_agency_k3(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.civiko_padova_agency_collapse_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.civiko_padova_agency_same_office(text, text) TO service_role;

-- ── pairs: PHOTO required, same-office excluded, same-house geo+mq ────────
CREATE OR REPLACE FUNCTION public.civiko_padova_matcher_v4_pairs()
RETURNS TABLE(a_id bigint, b_id bigint, shared_photos integer, prezzo_ratio numeric,
              dist_m numeric, geo_unita_testo_ok boolean, pair_kind text,
              match_version text, evidence_branch text, photo_strong boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH c AS MATERIALIZED (
    SELECT * FROM public.civiko_padova_matcher_v4_candidates()
  ),
  photo_ev AS MATERIALIZED (
    SELECT LEAST(e.listing_a, e.listing_b)::bigint AS a,
           GREATEST(e.listing_a, e.listing_b)::bigint AS b,
           max(coalesce(e.shared_photos, 0))::int AS shared_photos
      FROM public.civiko_listing_photo_pair_evidence e
      JOIN public.civiko_photo_evidence_contract() k
        ON e.evidence_kind = k.evidence_kind
       AND e.match_version = k.match_version
       AND e.algo = k.algo
     GROUP BY 1, 2
    HAVING max(coalesce(e.shared_photos, 0)) >= 1
  ),
  photo_base AS (
    SELECT x.id AS a_id, y.id AS b_id, x, y, pe.shared_photos,
           (greatest(x.prezzo, y.prezzo)::numeric
             / NULLIF(least(x.prezzo, y.prezzo), 0)::numeric) AS prezzo_ratio,
           CASE WHEN x.lat IS NOT NULL AND x.lng IS NOT NULL
                     AND y.lat IS NOT NULL AND y.lng IS NOT NULL
                THEN public.padova_haversine_m(x.lat, x.lng, y.lat, y.lng)::numeric
           END AS dist_m
      FROM photo_ev pe
      JOIN c x ON x.id = pe.a
      JOIN c y ON y.id = pe.b
       AND y.id > x.id
       AND y.czone_slug = x.czone_slug
       AND y.agency_key <> x.agency_key
       AND NOT public.civiko_padova_agency_same_office(x.agency_raw, y.agency_raw)
       AND y.canonical_listing_id <> x.canonical_listing_id
       AND x.is_asta IS NOT TRUE AND y.is_asta IS NOT TRUE
       AND x.is_mls IS NOT TRUE AND y.is_mls IS NOT TRUE
  ),
  photo_edges AS (
    SELECT b.a_id, b.b_id, b.shared_photos, b.prezzo_ratio, b.dist_m,
           false AS geo_unita_testo_ok,
           CASE WHEN b.shared_photos >= 2 AND b.prezzo_ratio > 1.10
                THEN 'FOTO_PHASH_2' ELSE 'FOTO_PHASH_1' END AS pair_kind,
           'PHOTO'::text AS evidence_branch,
           true AS photo_strong
      FROM photo_base b
     WHERE b.prezzo_ratio IS NOT NULL
       AND b.prezzo_ratio <= 1.15
       AND b.shared_photos >= 1
       AND (b.prezzo_ratio <= 1.10 OR b.shared_photos >= 2)
       AND (b.x).mq IS NOT NULL AND (b.y).mq IS NOT NULL
       AND least((b.x).mq, (b.y).mq) > 0
       AND greatest((b.x).mq, (b.y).mq)::numeric
             <= greatest(least((b.x).mq, (b.y).mq)::numeric + 5,
                         least((b.x).mq, (b.y).mq)::numeric * 1.05)
       AND (
         (
           coalesce((b.x).via_n, '') <> ''
           AND coalesce((b.x).civico_n, '') <> ''
           AND (b.x).via_n = (b.y).via_n
           AND (b.x).civico_n = (b.y).civico_n
         )
         OR (b.dist_m IS NOT NULL AND b.dist_m <= 40)
       )
  )
  SELECT m.a_id, m.b_id, m.shared_photos::int, round(m.prezzo_ratio, 4) AS prezzo_ratio,
         m.dist_m, m.geo_unita_testo_ok, m.pair_kind, 'v4'::text AS match_version,
         m.evidence_branch,
         (m.evidence_branch = 'PHOTO' AND m.photo_strong) AS photo_strong
    FROM photo_edges m
   WHERE m.prezzo_ratio <= 1.15
     AND m.shared_photos >= 1;
$function$;

REVOKE ALL ON FUNCTION public.civiko_padova_matcher_v4_pairs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_padova_matcher_v4_pairs() TO service_role;

COMMENT ON FUNCTION public.civiko_padova_matcher_v4_pairs() IS
  'Padova matcher: PHOTO pHash mandatory (shared_photos >= 1). No STRUCTURAL-only pairs. Same-office aliases (agency_k3 collapse) excluded. Same house: (via_n AND civico_n) OR dist_m <= 40, plus mq within +5 / 5%.';

-- ── group gate: photos mandatory; mq + locali always; n_agenzie >= 2 ──────
CREATE OR REPLACE FUNCTION public.civiko_padova_img_group_gate_ok(
  p_n_zone bigint,
  p_has_asta boolean,
  p_has_mls boolean,
  p_n_agenzie bigint,
  p_n_annunci_canonici bigint,
  p_n_rows integer,
  p_n_pairs bigint,
  p_n_pairs_attese bigint,
  p_n_pairs_over15 bigint,
  p_n_pairs_photo_weak bigint,
  p_n_pairs_photo bigint,
  p_prezzo_min numeric,
  p_prezzo_max numeric,
  p_mq_min numeric,
  p_mq_max numeric,
  p_n_locali bigint,
  p_n_bagni bigint,
  p_n_piani bigint,
  p_n_tipologie bigint
)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    p_n_zone = 1
    AND p_has_asta IS NOT TRUE
    AND p_has_mls IS NOT TRUE
    AND p_n_agenzie >= 2
    AND p_n_annunci_canonici >= 2
    AND p_n_annunci_canonici = p_n_rows
    AND p_n_rows BETWEEN 2 AND 4
    AND p_n_pairs = p_n_pairs_attese
    AND coalesce(p_n_pairs_over15, 0) = 0
    AND coalesce(p_n_pairs_photo_weak, 0) = 0
    AND coalesce(p_n_pairs_photo, 0) > 0
    AND p_prezzo_min > 0
    AND p_prezzo_max <= p_prezzo_min * 1.15
    AND coalesce(p_mq_min, 0) > 0
    AND p_mq_max <= greatest(p_mq_min + 5, p_mq_min * 1.05)
    AND p_n_locali = 1;
$function$;

-- ── recompute: n_agenzie uses collapsed keys (img groups Paula is reading) ─
DO $mig$
DECLARE
  v_src text;
  v_new text;
  v_old text := 'count(DISTINCT m.agency_key) AS n_agenzie';
  v_rep text :=
    'count(DISTINCT public.civiko_padova_agency_collapse_key(m.agency_raw)) FILTER (WHERE coalesce(m.fonte, '''') IS DISTINCT FROM ''subito'' AND coalesce(public.civiko_padova_agency_collapse_key(m.agency_raw), '''') <> '''') AS n_agenzie';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'recompute_padova_listings_contendibili';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'recompute_padova_listings_contendibili non trovata';
  END IF;
  IF position(v_old IN v_src) = 0 THEN
    RAISE EXCEPTION 'Patch fail-closed: count(DISTINCT m.agency_key) AS n_agenzie non trovato';
  END IF;
  v_new := replace(v_src, v_old, v_rep);
  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'recompute_padova_listings_contendibili';
  IF position('civiko_padova_agency_collapse_key(m.agency_raw)' IN v_src) = 0
     OR position(v_old IN v_src) > 0 THEN
    RAISE EXCEPTION 'Verifica post-patch fallita: n_agenzie non usa agency collapse';
  END IF;
END
$mig$;

-- Gate fixtures: photos required; same agency fails; mq/locali always apply.
DO $qa$
DECLARE
  r record;
  v_fail int := 0;
  v_got boolean;
BEGIN
  IF public.civiko_padova_agency_same_office('Gabetti Padova Centro', 'Gabetti Centro') IS NOT TRUE THEN
    RAISE EXCEPTION 'agency_k3 collapse: Gabetti Padova Centro / Gabetti Centro must be ONE office';
  END IF;
  IF public.civiko_padova_agency_same_office('Tecnocasa Padova', 'Tecnocasa') IS NOT TRUE THEN
    RAISE EXCEPTION 'agency_k3 collapse: Tecnocasa Padova / Tecnocasa must be ONE office';
  END IF;
  IF public.civiko_padova_agency_same_office('Immobiliare Rossi', 'Immobiliare Bianchi') IS TRUE THEN
    RAISE EXCEPTION 'agency_k3 collapse must not merge distinct Immobiliare * brands';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      -- nome, n_zone, asta, mls, n_ag, n_can, n_rows, n_pairs, attese, over15, weak, n_photo, pmin, pmax, mqmin, mqmax, nloc, nbag, npia, ntip, atteso
      ('PHOTO_ok_due_agenzie',     1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,80::numeric,82::numeric,1::bigint,1::bigint,1::bigint,1::bigint,true),
      ('PHOTO_zero_foto',          1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,0::bigint,200000::numeric,210000::numeric,80::numeric,82::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_stessa_agenzia',     1,false,false,1::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,80::numeric,82::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_mq_divergenti',      1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,60::numeric,95::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_locali_divergenti',  1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,80::numeric,82::numeric,2::bigint,1::bigint,1::bigint,1::bigint,false),
      ('STRUCT_senza_foto',        1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,0::bigint,200000::numeric,210000::numeric,80::numeric,82::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false)
    ) AS t(nome, n_zone, asta, mls, n_ag, n_can, n_rows, n_pairs, attese,
           over15, weak, n_photo, pmin, pmax, mqmin, mqmax, nloc, nbag, npia, ntip, atteso)
  LOOP
    v_got := public.civiko_padova_img_group_gate_ok(
      r.n_zone::bigint, r.asta, r.mls, r.n_ag, r.n_can, r.n_rows, r.n_pairs,
      r.attese, r.over15, r.weak, r.n_photo, r.pmin, r.pmax, r.mqmin, r.mqmax,
      r.nloc, r.nbag, r.npia, r.ntip);
    IF v_got IS DISTINCT FROM r.atteso THEN
      v_fail := v_fail + 1;
      RAISE WARNING 'Fixture gate fallita: % (atteso %, got %)', r.nome, r.atteso, v_got;
    END IF;
  END LOOP;
  IF v_fail > 0 THEN
    RAISE EXCEPTION 'Fixture gate foto+agenzie: % casi non conformi', v_fail;
  END IF;
END
$qa$;
