-- =====================================================================
-- CIVIKO ONLY — MATCHER v4 FORWARD REPAIR (dopo 20260806181048)
-- 1) contratto prove foto esatto: evidence_kind + match_version v4 + algo
-- 2) nessun veto globale di metadata sui gruppi con ramo PHOTO
-- 3) gate di gruppo centralizzato e testabile
-- 4) fixture QA vincolanti (positivi RAISE, negativi RAISE)
-- Nessun recompute reale, nessun provider, nessun cron.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0) Contratto versione/algoritmo delle prove fotografiche (v4)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.civiko_photo_evidence_contract()
RETURNS TABLE(evidence_kind text, match_version text, algo text)
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT 'IMAGE_PHASH_V1'::text,
         'v4-padova-photo-pair'::text,
         'phash-dct-8x8-v1'::text;
$function$;

-- ---------------------------------------------------------------------
-- 1) Gate di gruppo: metadata SOLO nel ramo interamente STRUCTURAL
-- ---------------------------------------------------------------------
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
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT
    -- REJECT COMUNI A OGNI RAMO
    p_n_zone = 1
    AND p_has_asta IS NOT TRUE
    AND p_has_mls IS NOT TRUE
    AND p_n_agenzie >= 2
    AND p_n_annunci_canonici >= 2
    AND p_n_annunci_canonici = p_n_rows
    AND p_n_rows BETWEEN 2 AND 4
    AND p_n_pairs = p_n_pairs_attese          -- complete-link obbligatorio
    AND coalesce(p_n_pairs_over15, 0) = 0
    AND coalesce(p_n_pairs_photo_weak, 0) = 0
    AND p_prezzo_min > 0
    AND p_prezzo_max <= p_prezzo_min * 1.15   -- prezzo sempre obbligatorio
    AND (
      -- RAMO PHOTO/MISTO: nessun requisito di mq/locali/bagni/piano/tipologia
      coalesce(p_n_pairs_photo, 0) > 0
      OR (
        -- RAMO INTERAMENTE STRUCTURAL: metadata pienamente obbligatori
        coalesce(p_mq_min, 0) > 0
        AND p_mq_max <= greatest(p_mq_min + 5, p_mq_min * 1.05)
        AND p_n_locali = 1
        AND p_n_bagni <= 1
        AND p_n_piani <= 1
        AND p_n_tipologie <= 1
      )
    );
$function$;

REVOKE ALL ON FUNCTION public.civiko_padova_img_group_gate_ok(
  bigint, boolean, boolean, bigint, bigint, integer, bigint, bigint, bigint,
  bigint, bigint, numeric, numeric, numeric, numeric, bigint, bigint, bigint, bigint
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.civiko_padova_img_group_gate_ok(
  bigint, boolean, boolean, bigint, bigint, integer, bigint, bigint, bigint,
  bigint, bigint, numeric, numeric, numeric, numeric, bigint, bigint, bigint, bigint
) TO service_role;
REVOKE ALL ON FUNCTION public.civiko_photo_evidence_contract() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.civiko_photo_evidence_contract() TO service_role;

-- ---------------------------------------------------------------------
-- 2) Matcher pairs v4: photo_ev con versione/algo ESATTI
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.civiko_padova_matcher_v4_pairs()
RETURNS TABLE(a_id bigint, b_id bigint, shared_photos integer, prezzo_ratio numeric,
              dist_m numeric, geo_unita_testo_ok boolean, pair_kind text,
              match_version text, evidence_branch text, photo_strong boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH c AS (
    SELECT * FROM public.civiko_padova_matcher_v4_candidates()
  ),
  -- Contratto ESATTO: solo prove prodotte dal certificatore v4 corrente.
  -- Le prove v3 stantie non certificano mai.
  photo_ev AS (
    SELECT LEAST(e.listing_a, e.listing_b)::bigint AS a,
           GREATEST(e.listing_a, e.listing_b)::bigint AS b,
           max(coalesce(e.shared_photos, 0))::int AS shared_photos
      FROM public.civiko_listing_photo_pair_evidence e
      JOIN public.civiko_photo_evidence_contract() k
        ON e.evidence_kind = k.evidence_kind
       AND e.match_version = k.match_version
       AND e.algo = k.algo
     GROUP BY 1, 2
  ),
  -- REJECT COMUNI: stessa canonical listing, stessa agency, asta/MLS, fuori
  -- Comune Padova o fuori allowlist 8 zone (nei candidati), prezzo > 15%.
  -- Stessa property identity / stesso civico fra agenzie DIVERSE non e' veto.
  base AS (
    SELECT x.id AS a_id, y.id AS b_id, x, y,
           (greatest(x.prezzo, y.prezzo)::numeric
              / NULLIF(least(x.prezzo, y.prezzo), 0)::numeric) AS prezzo_ratio,
           CASE WHEN x.lat IS NOT NULL AND x.lng IS NOT NULL
                     AND y.lat IS NOT NULL AND y.lng IS NOT NULL
                THEN public.padova_haversine_m(x.lat, x.lng, y.lat, y.lng)::numeric
           END AS dist_m
      FROM c x
      JOIN c y
        ON y.id > x.id
       AND y.czone_slug = x.czone_slug
       AND y.agency_key <> x.agency_key
       AND y.canonical_listing_id <> x.canonical_listing_id
       AND x.is_asta IS NOT TRUE AND y.is_asta IS NOT TRUE
       AND x.is_mls IS NOT TRUE AND y.is_mls IS NOT TRUE
  ),
  -- RAMO PHOTO — nessun requisito globale di piano/tipologia/locali/mq/
  -- bagni/civico/identity_key.
  photo_edges AS (
    SELECT b.a_id, b.b_id, pe.shared_photos, b.prezzo_ratio, b.dist_m,
           false AS geo_unita_testo_ok,
           CASE WHEN pe.shared_photos >= 2 AND b.prezzo_ratio > 1.10
                THEN 'FOTO_PHASH_2' ELSE 'FOTO_PHASH_1' END AS pair_kind,
           'PHOTO'::text AS evidence_branch,
           true AS photo_strong
      FROM base b
      JOIN photo_ev pe ON pe.a = b.a_id AND pe.b = b.b_id
     WHERE b.prezzo_ratio IS NOT NULL
       AND (
         (b.prezzo_ratio <= 1.10
          AND pe.shared_photos >= 1
          AND (
            (b.x).locali = (b.y).locali
            OR greatest((b.x).mq, (b.y).mq)::numeric
                 / NULLIF(least((b.x).mq, (b.y).mq), 0)::numeric <= 1.15
            OR (b.dist_m IS NOT NULL AND b.dist_m <= 150)
            OR ((b.x).via_n IS NOT NULL AND (b.x).via_n = (b.y).via_n)
            OR (coalesce((b.x).civico_n,'') <> ''
                AND (b.x).civico_n = (b.y).civico_n)
            OR ((b.x).descr_fp IS NOT NULL AND (b.x).descr_fp = (b.y).descr_fp)
            OR ((b.x).tipologia IS NOT NULL AND (b.x).tipologia = (b.y).tipologia)
          ))
         OR (b.prezzo_ratio > 1.10 AND b.prezzo_ratio <= 1.15 AND pe.shared_photos >= 2)
       )
  ),
  -- RAMO STRUCTURAL — mantiene interamente i propri requisiti di metadata.
  structural_edges AS (
    SELECT b.a_id, b.b_id, 0::int AS shared_photos, b.prezzo_ratio, b.dist_m,
           (
             b.dist_m IS NOT NULL AND b.dist_m <= 30
             AND (b.x).descr_fp IS NOT NULL AND (b.y).descr_fp IS NOT NULL
             AND (b.x).descr_fp = (b.y).descr_fp
           ) AS geo_unita_testo_ok,
           CASE WHEN b.prezzo_ratio <= 1.10 THEN 'STRUTTURALE_10'
                ELSE 'GEO_UNITA_TESTO' END AS pair_kind,
           'STRUCTURAL'::text AS evidence_branch,
           false AS photo_strong
      FROM base b
     WHERE b.prezzo_ratio IS NOT NULL
       AND b.prezzo_ratio <= 1.15
       AND (b.x).locali = (b.y).locali
       AND (b.x).tipologia IS NOT NULL AND (b.y).tipologia IS NOT NULL
       AND (b.x).tipologia = (b.y).tipologia
       AND (b.x).piano_k IS NOT NULL AND (b.y).piano_k IS NOT NULL
       AND (b.x).piano_k = (b.y).piano_k
       AND least((b.x).mq, (b.y).mq) > 0
       AND greatest((b.x).mq, (b.y).mq)::numeric
             <= greatest(least((b.x).mq, (b.y).mq)::numeric + 5,
                         least((b.x).mq, (b.y).mq)::numeric * 1.05)
       AND ((b.x).bagni IS NULL OR (b.y).bagni IS NULL OR (b.x).bagni = (b.y).bagni)
       AND (
         b.prezzo_ratio <= 1.10
         OR (
           b.dist_m IS NOT NULL AND b.dist_m <= 30
           AND (b.x).descr_fp IS NOT NULL AND (b.y).descr_fp IS NOT NULL
           AND (b.x).descr_fp = (b.y).descr_fp
         )
       )
  ),
  unioned AS (
    SELECT * FROM photo_edges
    UNION ALL
    SELECT * FROM structural_edges
  ),
  merged AS (
    SELECT u.a_id, u.b_id,
           max(u.shared_photos) AS shared_photos,
           min(u.prezzo_ratio) AS prezzo_ratio,
           min(u.dist_m) AS dist_m,
           bool_or(u.geo_unita_testo_ok) AS geo_unita_testo_ok,
           (array_agg(u.pair_kind ORDER BY u.shared_photos DESC, u.pair_kind))[1] AS pair_kind,
           CASE WHEN bool_or(u.evidence_branch = 'PHOTO') THEN 'PHOTO' ELSE 'STRUCTURAL' END
             AS evidence_branch,
           bool_or(u.photo_strong) AS photo_strong
      FROM unioned u
     GROUP BY u.a_id, u.b_id
  )
  SELECT m.a_id, m.b_id, m.shared_photos::int, round(m.prezzo_ratio, 4) AS prezzo_ratio,
         m.dist_m, m.geo_unita_testo_ok, m.pair_kind, 'v4'::text AS match_version,
         m.evidence_branch,
         (m.evidence_branch = 'PHOTO' AND m.photo_strong) AS photo_strong
    FROM merged m
   WHERE m.prezzo_ratio <= 1.15;
$function$;

-- ---------------------------------------------------------------------
-- 3) recompute: sostituzione chirurgica del gate di gruppo, fail-closed
--    (patch sulla definizione LIVE, nessuna riscrittura cieca)
-- ---------------------------------------------------------------------
DO $mig$
DECLARE
  v_src text;
  v_new text;
  v_old_gate constant text :=
'  CREATE TEMP TABLE _img_ok ON COMMIT DROP AS
  SELECT g.*
    FROM _img_grp g
   WHERE g.n_zone = 1
     AND g.has_asta IS NOT TRUE
     AND g.has_mls IS NOT TRUE
     AND g.n_agenzie >= 2
     AND g.n_annunci_canonici >= 2
     AND g.n_annunci_canonici = g.n_rows
     AND g.n_rows BETWEEN 2 AND 4
     AND g.n_pairs = g.n_pairs_attese
     AND g.n_pairs_over15 = 0
     AND g.n_pairs_photo_weak = 0
     AND g.mq_min > 0
     AND g.prezzo_min > 0
     AND g.prezzo_max::numeric <= g.prezzo_min::numeric * 1.15
     AND (
       g.n_pairs_photo > 0
       OR (
         g.n_locali = 1
         AND g.mq_max::numeric <= greatest(g.mq_min::numeric + 5, g.mq_min::numeric * 1.05)
         AND g.n_bagni <= 1
         AND g.n_piani <= 1
         AND g.n_tipologie <= 1
       )
     );';
  v_new_gate constant text :=
'  -- Gate centralizzato: mq_min/mq/locali/bagni/piano/tipologia SOLO nel ramo
  -- interamente STRUCTURAL. Un gruppo con almeno una prova fotografica non
  -- viene mai scartato per metadati mancanti o divergenti.
  CREATE TEMP TABLE _img_ok ON COMMIT DROP AS
  SELECT g.*
    FROM _img_grp g
   WHERE public.civiko_padova_img_group_gate_ok(
           g.n_zone, g.has_asta, g.has_mls, g.n_agenzie, g.n_annunci_canonici,
           g.n_rows, g.n_pairs, g.n_pairs_attese, g.n_pairs_over15,
           g.n_pairs_photo_weak, g.n_pairs_photo,
           g.prezzo_min::numeric, g.prezzo_max::numeric,
           g.mq_min::numeric, g.mq_max::numeric,
           g.n_locali, g.n_bagni, g.n_piani, g.n_tipologie);';
  v_old_qa constant text :=
'      OR (coalesce(n_pairs_photo, 0) = 0
          AND (
            n_locali <> 1
            OR n_bagni > 1
            OR n_piani > 1
            OR n_tipologie > 1
            OR mq_max::numeric > greatest(mq_min::numeric + 5, mq_min::numeric * 1.05)
          ))';
  v_new_qa constant text :=
'      OR (coalesce(n_pairs_photo, 0) = 0
          AND (
            n_locali <> 1
            OR n_bagni > 1
            OR n_piani > 1
            OR n_tipologie > 1
            OR coalesce(mq_min, 0) <= 0
            OR mq_max::numeric > greatest(mq_min::numeric + 5, mq_min::numeric * 1.05)
          ))';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'recompute_padova_listings_contendibili';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'recompute_padova_listings_contendibili non trovata';
  END IF;
  IF position(v_old_gate IN v_src) = 0 THEN
    RAISE EXCEPTION 'Patch fail-closed: gate _img_ok atteso non trovato nella definizione live';
  END IF;
  IF position(v_old_qa IN v_src) = 0 THEN
    RAISE EXCEPTION 'Patch fail-closed: blocco QA strutturale atteso non trovato';
  END IF;

  v_new := replace(replace(v_src, v_old_gate, v_new_gate), v_old_qa, v_new_qa);
  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'recompute_padova_listings_contendibili';
  IF position('civiko_padova_img_group_gate_ok' IN v_src) = 0
     OR position(v_old_gate IN v_src) > 0
     OR position(v_new_qa IN v_src) = 0 THEN
    RAISE EXCEPTION 'Verifica post-patch fallita: gate _img_ok non sostituito';
  END IF;
END
$mig$;

-- ---------------------------------------------------------------------
-- 4a) FIXTURE AUTOCONSISTENTE DEL GATE DI GRUPPO
--     PHOTO con metadata mancanti/divergenti = PASS
--     canonical dup / stessa agenzia / asta / MLS / >15% / clique incompleta = FAIL
-- ---------------------------------------------------------------------
DO $qa$
DECLARE
  r record;
  v_fail int := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- nome, n_zone, asta, mls, n_agenzie, n_canon, n_rows, n_pairs, attese,
      -- over15, photo_weak, n_photo, pmin, pmax, mqmin, mqmax, nloc, nbag, npia, ntip, atteso
      ('PHOTO_mq_mancante',      1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,0::numeric,0::numeric,2::bigint,0::bigint,0::bigint,0::bigint,true),
      ('PHOTO_metadata_divergenti',1,false,false,3::bigint,3::bigint,3,3::bigint,3::bigint,0::bigint,0::bigint,2::bigint,200000::numeric,220000::numeric,60::numeric,95::numeric,3::bigint,2::bigint,3::bigint,2::bigint,true),
      ('STRUCT_metadata_coerenti',1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,0::bigint,200000::numeric,210000::numeric,80::numeric,82::numeric,1::bigint,1::bigint,1::bigint,1::bigint,true),
      ('STRUCT_mq_mancante',     1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,0::bigint,200000::numeric,210000::numeric,0::numeric,0::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('STRUCT_mq_divergenti',   1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,0::bigint,200000::numeric,210000::numeric,60::numeric,95::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_canonical_dup',    1,false,false,2::bigint,1::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,80::numeric,80::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_stessa_agenzia',   1,false,false,1::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,80::numeric,80::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_asta',             1,true, false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,80::numeric,80::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_mls',              1,false,true, 2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,80::numeric,80::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_prezzo_oltre_15',  1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,240000::numeric,80::numeric,80::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_edge_over15',      1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,1::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,80::numeric,80::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_clique_incompleta',1,false,false,3::bigint,3::bigint,3,2::bigint,3::bigint,0::bigint,0::bigint,2::bigint,200000::numeric,210000::numeric,80::numeric,80::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_zone_diverse',     2,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,80::numeric,80::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_weak',             1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,1::bigint,1::bigint,200000::numeric,210000::numeric,80::numeric,80::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false)
    ) AS t(nome, n_zone, asta, mls, n_ag, n_can, n_rows, n_pairs, attese,
           over15, weak, n_photo, pmin, pmax, mqmin, mqmax, nloc, nbag, npia, ntip, atteso)
  LOOP
    IF public.civiko_padova_img_group_gate_ok(
         r.n_zone::bigint, r.asta, r.mls, r.n_ag, r.n_can, r.n_rows, r.n_pairs,
         r.attese, r.over15, r.weak, r.n_photo, r.pmin, r.pmax, r.mqmin, r.mqmax,
         r.nloc, r.nbag, r.npia, r.ntip) IS DISTINCT FROM r.atteso THEN
      v_fail := v_fail + 1;
      RAISE WARNING 'Fixture gate fallita: % (atteso %)', r.nome, r.atteso;
    END IF;
  END LOOP;
  IF v_fail > 0 THEN
    RAISE EXCEPTION 'Fixture gate di gruppo: % casi non conformi al contratto', v_fail;
  END IF;
  RAISE NOTICE 'Fixture gate di gruppo: 14/14 conformi';
END
$qa$;

-- ---------------------------------------------------------------------
-- 4b) REGRESSIONE SUI DATI REALI — negativi e positivo VINCOLANTI
-- ---------------------------------------------------------------------
DO $qa$
DECLARE
  v_bad int;
  v_pos int;
  v_listings int;
  v_ev int;
BEGIN
  CREATE TEMP TABLE _qa_pairs ON COMMIT DROP AS
  SELECT * FROM public.civiko_padova_matcher_v4_pairs();

  SELECT count(*) INTO v_bad
    FROM _qa_pairs p
   WHERE (least(p.a_id, p.b_id), greatest(p.a_id, p.b_id))
         IN ((2309, 60498), (3619, 60735));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Regressione matcher: % coppie negative note riammesse', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM _qa_pairs p
   WHERE p.prezzo_ratio > 1.15
      OR (p.evidence_branch = 'PHOTO' AND p.shared_photos < 1)
      OR (p.evidence_branch = 'PHOTO' AND p.prezzo_ratio > 1.10 AND p.shared_photos < 2)
      OR p.evidence_branch IS NULL
      OR p.evidence_branch NOT IN ('PHOTO', 'STRUCTURAL');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Contratto edge violato: % coppie fuori banda o senza ramo', v_bad;
  END IF;

  -- Positivo 44787/101390: vincolante quando i presupposti esatti esistono.
  SELECT count(*) INTO v_listings
    FROM public.civiko_padova_matcher_v4_candidates() c
   WHERE c.id IN (44787, 101390);

  SELECT count(*) INTO v_ev
    FROM public.civiko_listing_photo_pair_evidence e
    JOIN public.civiko_photo_evidence_contract() k
      ON e.evidence_kind = k.evidence_kind
     AND e.match_version = k.match_version
     AND e.algo = k.algo
   WHERE least(e.listing_a, e.listing_b) = 44787
     AND greatest(e.listing_a, e.listing_b) = 101390
     AND e.shared_photos >= 1;

  SELECT count(*) INTO v_pos
    FROM _qa_pairs p
   WHERE (least(p.a_id, p.b_id), greatest(p.a_id, p.b_id)) IN ((44787, 101390));

  IF v_listings = 2 AND v_ev > 0 AND v_pos = 0 THEN
    RAISE EXCEPTION
      'Regressione matcher: prova positiva 44787/101390 presente (listing=%, evidence v4=%) ma nessuna edge generata',
      v_listings, v_ev;
  END IF;
  RAISE NOTICE 'Fixture positivo 44787/101390 — listing=%, evidence v4=%, edge=%',
    v_listings, v_ev, v_pos;
END
$qa$;