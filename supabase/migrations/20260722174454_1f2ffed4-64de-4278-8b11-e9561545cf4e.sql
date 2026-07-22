CREATE OR REPLACE FUNCTION public.recompute_padova_contendibili()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_r1 jsonb;
  v_r2 jsonb;
BEGIN
  v_r1 := public.recompute_padova_listings_contendibili();
  v_r2 := public.recompute_padova_contendibili_extras();
  RETURN jsonb_build_object('ok', true, 'listings', v_r1, 'extras', v_r2);
END;
$function$;

DO $mig$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname='recompute_padova_listings_contendibili' AND pronargs=0;

  v_new := regexp_replace(
    v_def,
    E'(UPDATE\\s+_cand\\s+SET\\s+agency_key\\s*=\\s*CASE\\s+WHEN\\s+coalesce\\(agency_core,''''\\)\\s*<>\\s*''''\\s+THEN\\s+agency_core\\s+ELSE\\s+agency_n_full\\s+END)\\s*;',
    E'\\1 WHERE true;',
    'i'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'Patch non applicata: pattern UPDATE _cand non trovato';
  END IF;

  EXECUTE v_new;
END
$mig$;