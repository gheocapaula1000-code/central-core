-- CIVIKO ONE — cardinality-safe publication for Padova recompute.
-- Fixes SQLSTATE 21000 without dropping source rows or weakening any QA gate.

DO $patch$
DECLARE
  src text;
  out text;
  nl constant text := chr(10);
  publish_anchor constant text :=
    '  -- ═══════════════════════════════════════════════════════════════════' || chr(10) ||
    '  -- D) PUBBLICAZIONE (transazionale)' || chr(10) ||
    '  -- ═══════════════════════════════════════════════════════════════════' || chr(10);
  mp_source_anchor constant text := $mp$
  FROM (
    SELECT czone_slug, chiave_match, fonti, n_portali, n_agenzie, agenzie,
           prezzo_min, prezzo_max, mq_avg, locali, bagni_pick, quartiere,
           lat, lng, urls, n_rows, last_seen_at FROM _fg_mp
    UNION ALL
    SELECT czone_slug, chiave_match, fonti, n_portali, n_agenzie, agenzie,
           prezzo_min, prezzo_max, mq_avg, locali, bagni_pick, quartiere,
           lat, lng, urls, n_rows, last_seen_at FROM _fg_mp_tol
    UNION ALL
    SELECT czone_slug, chiave_match, fonti, n_portali, n_agenzie, agenzie,
           prezzo_min, prezzo_max, mq_avg, locali, bagni_pick, quartiere,
           lat, lng, urls, n_rows, last_seen_at FROM _fg_geo_mp
  ) f
$mp$;
  mp_delete_anchor constant text := $del$
  DELETE FROM public.padova_multi_portale mp
   WHERE mp.chiave_match IS NULL
      OR (NOT EXISTS (SELECT 1 FROM _fg_mp f      WHERE f.chiave_match = mp.chiave_match)
      AND NOT EXISTS (SELECT 1 FROM _fg_mp_tol f  WHERE f.chiave_match = mp.chiave_match)
      AND NOT EXISTS (SELECT 1 FROM _fg_geo_mp f  WHERE f.chiave_match = mp.chiave_match));
$del$;
  cardinality_stage constant text := $stage$
  -- cardinality-safe-v1: disambigua collisioni serializzate e rimuove
  -- esclusivamente duplicati byte-identici prima degli upsert.
  UPDATE _cert c
     SET chiave_match = c.chiave_match || '|K:' || md5(jsonb_build_array(
       c.czone_slug, c.via_n, c.civico_n, c.locali,
       c.tipologia, c.kind, c.ev
     )::text)
   WHERE c.chiave_match IN (
     SELECT d.chiave_match
       FROM _cert d
      GROUP BY d.chiave_match
     HAVING count(*) > 1
   );

  IF EXISTS (
    SELECT 1
      FROM _cert c
     GROUP BY c.chiave_match
    HAVING count(*) > 1
       AND count(DISTINCT to_jsonb(c)) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '21000',
      MESSAGE = 'duplicate divergent contendibili publish key';
  END IF;

  DELETE FROM _cert a
   USING _cert b
   WHERE a.ctid > b.ctid
     AND a.chiave_match = b.chiave_match;
  CREATE UNIQUE INDEX _cert_publish_chiave_match_uq
    ON _cert (chiave_match);
  SELECT count(*) INTO v_cert FROM _cert;

  CREATE TEMP TABLE _mp_publish ON COMMIT DROP AS
  SELECT 1::smallint AS source_rank,
         czone_slug, chiave_match, fonti, n_portali, n_agenzie, agenzie,
         prezzo_min, prezzo_max, mq_avg, locali, bagni_pick, quartiere,
         lat, lng, urls, n_rows, last_seen_at
    FROM _fg_mp
  UNION ALL
  SELECT 2::smallint AS source_rank,
         czone_slug, chiave_match, fonti, n_portali, n_agenzie, agenzie,
         prezzo_min, prezzo_max, mq_avg, locali, bagni_pick, quartiere,
         lat, lng, urls, n_rows, last_seen_at
    FROM _fg_mp_tol
  UNION ALL
  SELECT 3::smallint AS source_rank,
         czone_slug, chiave_match, fonti, n_portali, n_agenzie, agenzie,
         prezzo_min, prezzo_max, mq_avg, locali, bagni_pick, quartiere,
         lat, lng, urls, n_rows, last_seen_at
    FROM _fg_geo_mp;

  UPDATE _mp_publish m
     SET chiave_match = m.chiave_match || '|K:' || md5(jsonb_build_array(
       m.source_rank, m.czone_slug, m.fonti, m.n_agenzie, m.urls
     )::text)
   WHERE m.chiave_match IN (
     SELECT d.chiave_match
       FROM _mp_publish d
      GROUP BY d.chiave_match
     HAVING count(*) > 1
   );

  IF EXISTS (
    SELECT 1
      FROM _mp_publish m
     GROUP BY m.chiave_match
    HAVING count(*) > 1
       AND count(DISTINCT (to_jsonb(m) - 'source_rank')) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '21000',
      MESSAGE = 'duplicate divergent multi_portale publish key';
  END IF;

  DELETE FROM _mp_publish a
   USING _mp_publish b
   WHERE a.ctid > b.ctid
     AND a.chiave_match = b.chiave_match;
  CREATE UNIQUE INDEX _mp_publish_chiave_match_uq
    ON _mp_publish (chiave_match);

$stage$;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'recompute_padova_listings_contendibili'
     AND p.pronargs = 0;

  IF src IS NULL THEN
    RAISE EXCEPTION 'recompute_padova_listings_contendibili() non trovata';
  END IF;

  IF position('cardinality-safe-v1' in src) > 0 THEN
    RETURN;
  END IF;

  IF position(publish_anchor in src) = 0 THEN
    RAISE EXCEPTION 'anchor pubblicazione non trovato';
  END IF;
  IF position(mp_source_anchor in src) = 0 THEN
    RAISE EXCEPTION 'anchor sorgente multi_portale non trovato';
  END IF;
  IF position(mp_delete_anchor in src) = 0 THEN
    RAISE EXCEPTION 'anchor delete multi_portale non trovato';
  END IF;

  out := replace(src, publish_anchor,
    publish_anchor || cardinality_stage);
  out := replace(out, mp_source_anchor,
    nl || '  FROM _mp_publish f' || nl);
  out := replace(out, mp_delete_anchor,
    nl || '  DELETE FROM public.padova_multi_portale mp' || nl ||
    '   WHERE mp.chiave_match IS NULL' || nl ||
    '      OR NOT EXISTS (' || nl ||
    '        SELECT 1 FROM _mp_publish f' || nl ||
    '         WHERE f.chiave_match = mp.chiave_match' || nl ||
    '      );' || nl);

  IF out = src OR position('cardinality-safe-v1' in out) = 0 THEN
    RAISE EXCEPTION 'patch cardinality-safe non applicata';
  END IF;

  EXECUTE out;
END
$patch$;

COMMENT ON FUNCTION public.recompute_padova_listings_contendibili() IS
  'Recompute v3 unit-certified, aste fail-closed, evidence-backed, cardinality-safe-v1.';
