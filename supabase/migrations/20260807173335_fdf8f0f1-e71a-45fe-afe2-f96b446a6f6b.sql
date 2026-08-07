DO $mig$
DECLARE
  v_src text;
  v_out text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'civiko_padova_matcher_v4_candidates'
     AND p.pronargs = 0;

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'civiko_padova_matcher_v4_candidates() assente';
  END IF;

  IF position('WITH base AS MATERIALIZED (' in v_src) > 0 THEN
    RETURN;
  END IF;

  v_out := replace(v_src, 'WITH base AS (', 'WITH base AS MATERIALIZED (');
  IF v_out = v_src THEN
    RAISE EXCEPTION 'anchor CTE base matcher candidati non trovato';
  END IF;

  EXECUTE 'CREATE OR REPLACE FUNCTION public.civiko_padova_matcher_v4_candidates() '
       || 'RETURNS TABLE(id bigint, url text, fonte text, mq integer, locali integer, bagni integer, prezzo bigint, l_last_seen_at timestamptz, lat double precision, lng double precision, quartiere text, agency_raw text, agency_key text, via_n text, civico_n text, czone_slug text, canonical_listing_id text, piano_k text, tipologia text, descr_fp text, identity_key text, is_asta boolean, is_mls boolean, title_type_ok boolean) '
       || 'LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS '
       || '$fn$' || v_out || '$fn$';
END
$mig$;

REVOKE ALL ON FUNCTION public.civiko_padova_matcher_v4_candidates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_padova_matcher_v4_candidates() TO service_role;

COMMENT ON FUNCTION public.civiko_padova_matcher_v4_candidates() IS
  'Civiko Padova matcher v4 candidates: base MATERIALIZED per valutare normalizzazioni, JSON ed esclusioni una sola volta; contratto e output invariati.';