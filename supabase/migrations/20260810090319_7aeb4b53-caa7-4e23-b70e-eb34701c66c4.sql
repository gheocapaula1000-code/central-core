DO $do$
DECLARE src text; n0 int;
BEGIN
  SELECT prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'recompute_padova_listings_contendibili';

  src := replace(src,
    '  SELECT count(*) INTO v_prefilter FROM _cand;',
    '  CREATE INDEX ON _cand (id); CREATE INDEX ON _cand (url); ANALYZE _cand;'
    || E'\n  SELECT count(*) INTO v_prefilter FROM _cand;');

  src := replace(src,
    '  CREATE TEMP TABLE _pe ON COMMIT DROP AS',
    '  CREATE INDEX ON _photo_cand (id); CREATE INDEX ON _photo_cand (url); ANALYZE _photo_cand;'
    || E'\n  CREATE TEMP TABLE _pe ON COMMIT DROP AS');

  src := replace(src,
    '  CREATE TEMP TABLE _photo_cliques ON COMMIT DROP AS',
    '  CREATE INDEX ON _pe (a_id); CREATE INDEX ON _pe (b_id); ANALYZE _pe;'
    || E'\n  CREATE TEMP TABLE _photo_cliques ON COMMIT DROP AS');

  src := replace(src,
    '  CREATE TEMP TABLE _unit_ev ON COMMIT DROP AS',
    '  CREATE INDEX ON _unit (id); ANALYZE _unit;'
    || E'\n  CREATE TEMP TABLE _unit_ev ON COMMIT DROP AS');

  EXECUTE 'CREATE OR REPLACE FUNCTION public.recompute_padova_listings_contendibili() '
       || 'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS '
       || '$civiko_rc_20260810c$' || src || '$civiko_rc_20260810c$';
END $do$;