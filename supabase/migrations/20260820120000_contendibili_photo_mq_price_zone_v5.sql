-- Padova contendibili v5 — product truth (Paula / Civiko One, 2026-08-20)
--
-- A contendibile is the SAME property listed by multiple agencies WITHOUT
-- exclusive. Agencies hide via and civico. Asking for an address asks for
-- data that will never be public.
--
-- Identity signals (ALL required; via/civico are NEVER a hard gate):
--   1. shared perceptual-hash photos (civiko_listing_photo_pair_evidence)
--   2. compatible mq  (max <= max(min+5, min*1.05))
--   3. compatible price (ratio <= 1.15; 10-15% needs >= 2 shared photos)
--   4. same official commercial zone
--
-- The live 40 rows (MEDIA / v4-unit-certified+geo-unit-text-v4 /
-- UNIT_GEO_TEXT_V4) are false. They must be cleared on the next recompute,
-- not preserved to keep the count stable.
--
-- v4-unit-certified (civico + piano/ref/descr) stays too hungry: ~150/9799
-- listings have ev_civico_norm. It no longer publishes public contendibili.
-- geo-unit-text-v4 / UNIT_GEO_TEXT_V4 / MIXED_V4 no longer publish.

-- ── 1) pair compatibility helper (photo + mq + price + zone; no address) ──
CREATE OR REPLACE FUNCTION public.civiko_padova_photo_mq_price_zone_ok(
  p_shared_photos integer,
  p_prezzo_a numeric,
  p_prezzo_b numeric,
  p_mq_a numeric,
  p_mq_b numeric,
  p_zone_a text,
  p_zone_b text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $fn$
  SELECT
    coalesce(p_shared_photos, 0) >= 1
    AND coalesce(p_zone_a, '') <> ''
    AND p_zone_a = p_zone_b
    AND coalesce(p_prezzo_a, 0) > 0
    AND coalesce(p_prezzo_b, 0) > 0
    AND greatest(p_prezzo_a, p_prezzo_b)
          <= least(p_prezzo_a, p_prezzo_b) * 1.15
    AND (
      greatest(p_prezzo_a, p_prezzo_b)
        <= least(p_prezzo_a, p_prezzo_b) * 1.10
      OR coalesce(p_shared_photos, 0) >= 2
    )
    AND coalesce(p_mq_a, 0) > 0
    AND coalesce(p_mq_b, 0) > 0
    AND greatest(p_mq_a, p_mq_b)
          <= greatest(least(p_mq_a, p_mq_b) + 5, least(p_mq_a, p_mq_b) * 1.05);
$fn$;

REVOKE ALL ON FUNCTION public.civiko_padova_photo_mq_price_zone_ok(
  integer, numeric, numeric, numeric, numeric, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_padova_photo_mq_price_zone_ok(
  integer, numeric, numeric, numeric, numeric, text, text
) TO service_role;

COMMENT ON FUNCTION public.civiko_padova_photo_mq_price_zone_ok(
  integer, numeric, numeric, numeric, numeric, text, text
) IS
  'v5 contendibile pair: shared pHash + compatible mq + compatible price + same zone. Via/civico are not inputs.';

-- ── 2) pairs: PHOTO + mq + price + zone. No via/civico/dist_m gate. ──────
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
     WHERE public.civiko_padova_photo_mq_price_zone_ok(
             b.shared_photos,
             (b.x).prezzo::numeric, (b.y).prezzo::numeric,
             (b.x).mq::numeric, (b.y).mq::numeric,
             (b.x).czone_slug, (b.y).czone_slug)
  )
  SELECT m.a_id, m.b_id, m.shared_photos::int, round(m.prezzo_ratio, 4) AS prezzo_ratio,
         m.dist_m, m.geo_unita_testo_ok, m.pair_kind,
         'v5-photo-mq-price-zone'::text AS match_version,
         m.evidence_branch,
         true AS photo_strong
    FROM photo_edges m
   WHERE m.shared_photos >= 1;
$function$;

REVOKE ALL ON FUNCTION public.civiko_padova_matcher_v4_pairs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_padova_matcher_v4_pairs() TO service_role;

COMMENT ON FUNCTION public.civiko_padova_matcher_v4_pairs() IS
  'Padova matcher v5: PHOTO pHash + compatible mq + compatible price + same zone. Via/civico/dist_m are not required. No STRUCTURAL/geo-text pairs.';

-- ── 3) group gate: photos + mq + price + one zone; no structural fallback ─
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
    AND p_mq_max <= greatest(p_mq_min + 5, p_mq_min * 1.05);
$function$;

COMMENT ON FUNCTION public.civiko_padova_img_group_gate_ok(
  bigint, boolean, boolean, bigint, bigint, integer, bigint, bigint, bigint,
  bigint, bigint, numeric, numeric, numeric, numeric, bigint, bigint, bigint, bigint
) IS
  'v5 group gate: shared photos + mq band + price band + one zone + 2 agencies. Locali/via/civico are not required. No STRUCTURAL-only pass.';

-- ── 4) recompute: publish only IMAGE_PHASH v5; drop civico/via gates ──────
DO $mig$
DECLARE
  v_src text;
  v_new text;
  v_changed boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'recompute_padova_listings_contendibili';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'recompute_padova_listings_contendibili non trovata';
  END IF;
  v_new := v_src;

  -- Bump published image version; retire geo-text version string.
  IF position('v4-unit-certified+image-phash-v1' IN v_new) > 0 THEN
    v_new := replace(v_new,
      'v4-unit-certified+image-phash-v1',
      'v5-photo-mq-price-zone');
    v_changed := true;
  END IF;
  IF position('v4-unit-certified+geo-unit-text-v4' IN v_new) > 0 THEN
    v_new := replace(v_new,
      'v4-unit-certified+geo-unit-text-v4',
      'v5-photo-mq-price-zone');
    v_changed := true;
  END IF;

  -- Candidate pool: via must not be a hard gate.
  IF position(
       '    AND COALESCE(p.ev_via_norm, public.padova_via_key(p.indirizzo)) IS NOT NULL'
       IN v_new) > 0 THEN
    v_new := replace(v_new,
      '    AND COALESCE(p.ev_via_norm, public.padova_via_key(p.indirizzo)) IS NOT NULL',
      '    -- v5: via/civico are not a candidate gate');
    v_changed := true;
  END IF;

  -- Unit-certified (civico) path no longer publishes public contendibili.
  IF position(E'  FROM _cert f\n  ON CONFLICT (chiave_match) DO UPDATE' IN v_new) > 0 THEN
    v_new := replace(v_new,
      E'  FROM _cert f\n  ON CONFLICT (chiave_match) DO UPDATE',
      E'  FROM _cert f\n  WHERE false  -- v5: civico unit-certified does not publish\n  ON CONFLICT (chiave_match) DO UPDATE');
    v_changed := true;
  ELSE
    RAISE EXCEPTION 'Patch fail-closed: INSERT FROM _cert f non trovato';
  END IF;

  -- Always publish IMAGE_PHASH_V1 from _img_cert (never UNIT_GEO_TEXT / MIXED).
  IF position('THEN ''IMAGE_PHASH_V1'' ELSE ''UNIT_GEO_TEXT_V4'' END' IN v_new) > 0 THEN
    v_new := replace(v_new,
      'THEN ''IMAGE_PHASH_V1'' ELSE ''UNIT_GEO_TEXT_V4'' END',
      'THEN ''IMAGE_PHASH_V1'' ELSE ''IMAGE_PHASH_V1'' END');
    v_changed := true;
  END IF;
  IF position('THEN ''UNIT_GEO_TEXT_V4''' IN v_new) > 0 THEN
    v_new := replace(v_new, 'THEN ''UNIT_GEO_TEXT_V4''', 'THEN ''IMAGE_PHASH_V1''');
    v_changed := true;
  END IF;
  IF position('ELSE ''MIXED_V4'' END' IN v_new) > 0 THEN
    v_new := replace(v_new, 'ELSE ''MIXED_V4'' END', 'ELSE ''IMAGE_PHASH_V1'' END');
    v_changed := true;
  END IF;
  IF position('THEN ''geo30m-unit-descrfp-v4''' IN v_new) > 0 THEN
    v_new := replace(v_new, 'THEN ''geo30m-unit-descrfp-v4''', 'THEN ''phash-dct-8x8-v1''');
    v_changed := true;
  END IF;
  IF position('ELSE ''geo30m-unit-descrfp-v4'' END' IN v_new) > 0 THEN
    v_new := replace(v_new,
      'ELSE ''geo30m-unit-descrfp-v4'' END',
      'ELSE ''phash-dct-8x8-v1'' END');
    v_changed := true;
  END IF;
  IF position('ELSE ''phash-dct-8x8-v1+geo30m-unit-descrfp-v4'' END' IN v_new) > 0 THEN
    v_new := replace(v_new,
      'ELSE ''phash-dct-8x8-v1+geo30m-unit-descrfp-v4'' END',
      'ELSE ''phash-dct-8x8-v1'' END');
    v_changed := true;
  END IF;

  -- Stale cleanup: keep only photo groups. Drops the false geo-text 40.
  IF position(
       E'  DELETE FROM public.padova_contendibili pc\n   WHERE NOT EXISTS (SELECT 1 FROM _cert f WHERE f.chiave_match = pc.chiave_match)\n     AND NOT EXISTS (SELECT 1 FROM _img_cert g WHERE g.chiave_match = pc.chiave_match);'
       IN v_new) > 0 THEN
    v_new := replace(v_new,
      E'  DELETE FROM public.padova_contendibili pc\n   WHERE NOT EXISTS (SELECT 1 FROM _cert f WHERE f.chiave_match = pc.chiave_match)\n     AND NOT EXISTS (SELECT 1 FROM _img_cert g WHERE g.chiave_match = pc.chiave_match);',
      E'  DELETE FROM public.padova_contendibili pc\n   WHERE NOT EXISTS (SELECT 1 FROM _img_cert g WHERE g.chiave_match = pc.chiave_match)\n      OR pc.evidence_kind IN (''UNIT_GEO_TEXT_V4'', ''MIXED_V4'')\n      OR coalesce(pc.match_version, '''') LIKE ''%geo-unit-text%'';');
    v_changed := true;
  ELSIF position(
       'AND NOT EXISTS (SELECT 1 FROM _img_cert g WHERE g.chiave_match = pc.chiave_match)'
       IN v_new) > 0
        AND position('OR pc.evidence_kind IN' IN v_new) = 0 THEN
    RAISE EXCEPTION 'Patch fail-closed: DELETE padova_contendibili atteso non trovato';
  END IF;

  -- Post-write QA: only IMAGE_PHASH_V1 / v5 may remain.
  IF position(
       'WHERE pc.evidence_kind IN (''IMAGE_PHASH_V1'', ''UNIT_GEO_TEXT_V4'', ''MIXED_V4'')'
       IN v_new) > 0 THEN
    v_new := replace(v_new,
      'WHERE pc.evidence_kind IN (''IMAGE_PHASH_V1'', ''UNIT_GEO_TEXT_V4'', ''MIXED_V4'')',
      'WHERE pc.evidence_kind IN (''IMAGE_PHASH_V1'')');
    v_changed := true;
  ELSIF position(
       'WHERE pc.evidence_kind IN (''IMAGE_PHASH_V1'', ''UNIT_GEO_TEXT_V4'')'
       IN v_new) > 0 THEN
    v_new := replace(v_new,
      'WHERE pc.evidence_kind IN (''IMAGE_PHASH_V1'', ''UNIT_GEO_TEXT_V4'')',
      'WHERE pc.evidence_kind IN (''IMAGE_PHASH_V1'')');
    v_changed := true;
  END IF;

  -- Staging QA for photo groups: require at least one shared photo.
  IF position(
       E'      OR (coalesce(foto_condivise, 0) = 0\n          AND coalesce(n_pairs_geo, 0) = 0\n          AND prezzo_max::numeric > prezzo_min::numeric * 1.10)'
       IN v_new) > 0 THEN
    v_new := replace(v_new,
      E'      OR (coalesce(foto_condivise, 0) = 0\n          AND coalesce(n_pairs_geo, 0) = 0\n          AND prezzo_max::numeric > prezzo_min::numeric * 1.10)',
      E'      OR coalesce(foto_condivise, 0) = 0');
    v_changed := true;
  END IF;

  -- Post-write pair QA: foto_condivise = 0 is always a failure.
  IF position(
       E'       OR (coalesce((pc.match_metrics->>''foto_condivise'')::int, 0) = 0\n           AND coalesce((pc.match_metrics->>''coppie_geo_unita_testo'')::int, 0) = 0\n           AND pc.prezzo_max::numeric > pc.prezzo_min::numeric * 1.10)'
       IN v_new) > 0 THEN
    v_new := replace(v_new,
      E'       OR (coalesce((pc.match_metrics->>''foto_condivise'')::int, 0) = 0\n           AND coalesce((pc.match_metrics->>''coppie_geo_unita_testo'')::int, 0) = 0\n           AND pc.prezzo_max::numeric > pc.prezzo_min::numeric * 1.10)',
      E'       OR coalesce((pc.match_metrics->>''foto_condivise'')::int, 0) = 0');
    v_changed := true;
  END IF;

  IF NOT v_changed THEN
    RAISE EXCEPTION 'Patch fail-closed: nessuna modifica applicata al recompute';
  END IF;
  IF position('v5-photo-mq-price-zone' IN v_new) = 0 THEN
    RAISE EXCEPTION 'Patch fail-closed: match_version v5 non installata';
  END IF;
  IF position('WHERE false  -- v5: civico unit-certified does not publish' IN v_new) = 0 THEN
    RAISE EXCEPTION 'Patch fail-closed: publish _cert non disattivato';
  END IF;

  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'recompute_padova_listings_contendibili';
  IF position('v5-photo-mq-price-zone' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Verifica post-patch fallita: v5-photo-mq-price-zone assente';
  END IF;
  IF position('geo-unit-text-v4' IN v_src) > 0 THEN
    RAISE EXCEPTION 'Verifica post-patch fallita: geo-unit-text-v4 ancora presente';
  END IF;
  IF position('AND COALESCE(p.ev_via_norm, public.padova_via_key(p.indirizzo)) IS NOT NULL' IN v_src) > 0 THEN
    RAISE EXCEPTION 'Verifica post-patch fallita: via resta un gate sui candidati';
  END IF;
END
$mig$;

-- ── 5) one-shot: clear the false live 40 so count cannot stay "stable" ────
DELETE FROM public.padova_contendibili
 WHERE evidence_kind IN ('UNIT_GEO_TEXT_V4', 'MIXED_V4')
    OR coalesce(match_version, '') LIKE '%geo-unit-text%'
    OR coalesce(match_version, '') = 'v4-unit-certified';

-- ── 6) dry-run fixtures (no live listings; document address-less match) ───
DO $qa$
DECLARE
  v_fail int := 0;
  r record;
  v_got boolean;
BEGIN
  -- Pair helper: listing without via/civico still matches on photo+mq+price+zone.
  FOR r IN
    SELECT * FROM (VALUES
      -- nome, photos, prezzo_a, prezzo_b, mq_a, mq_b, zone_a, zone_b, atteso
      ('ok_senza_indirizzo',     2, 200000, 210000, 80, 82, 'centro-storico', 'centro-storico', true),
      ('ok_1_foto_sotto_10pct',  1, 200000, 209000, 80, 83, 'nord-arcella',   'nord-arcella',   true),
      ('ko_zone_diverse',        2, 200000, 210000, 80, 82, 'centro-storico', 'nord-arcella',   false),
      ('ko_mq_divergenti',       2, 200000, 210000, 60, 95, 'centro-storico', 'centro-storico', false),
      ('ko_prezzo_oltre_15',     3, 200000, 240000, 80, 82, 'centro-storico', 'centro-storico', false),
      ('ko_1_foto_10_15pct',     1, 200000, 226000, 80, 82, 'centro-storico', 'centro-storico', false),
      ('ok_2_foto_10_15pct',     2, 200000, 226000, 80, 82, 'centro-storico', 'centro-storico', true),
      ('ko_zero_foto',           0, 200000, 210000, 80, 82, 'centro-storico', 'centro-storico', false),
      ('ko_mq_assente',          2, 200000, 210000, 0,  82, 'centro-storico', 'centro-storico', false)
    ) AS t(nome, photos, pa, pb, ma, mb, za, zb, atteso)
  LOOP
    v_got := public.civiko_padova_photo_mq_price_zone_ok(
      r.photos, r.pa, r.pb, r.ma, r.mb, r.za, r.zb);
    IF v_got IS DISTINCT FROM r.atteso THEN
      v_fail := v_fail + 1;
      RAISE WARNING 'Fixture pair v5 fallita: % (atteso %, got %)', r.nome, r.atteso, v_got;
    END IF;
  END LOOP;

  -- Group gate: photos + mq + price + zone. Locali may diverge. No STRUCTURAL pass.
  FOR r IN
    SELECT * FROM (VALUES
      ('PHOTO_ok_senza_locali',    1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,80::numeric,82::numeric,2::bigint,0::bigint,0::bigint,0::bigint,true),
      ('PHOTO_zero_foto',          1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,0::bigint,200000::numeric,210000::numeric,80::numeric,82::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_stessa_agenzia',     1,false,false,1::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,80::numeric,82::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_mq_divergenti',      1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,60::numeric,95::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_mq_assente',         1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,0::numeric,0::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_prezzo_oltre_15',    1,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,240000::numeric,80::numeric,82::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
      ('PHOTO_zone_diverse',       2,false,false,2::bigint,2::bigint,2,1::bigint,1::bigint,0::bigint,0::bigint,1::bigint,200000::numeric,210000::numeric,80::numeric,82::numeric,1::bigint,1::bigint,1::bigint,1::bigint,false),
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
      RAISE WARNING 'Fixture gate v5 fallita: % (atteso %, got %)', r.nome, r.atteso, v_got;
    END IF;
  END LOOP;

  IF v_fail > 0 THEN
    RAISE EXCEPTION 'Fixture v5 photo+mq+price+zone: % casi non conformi', v_fail;
  END IF;
END
$qa$;
