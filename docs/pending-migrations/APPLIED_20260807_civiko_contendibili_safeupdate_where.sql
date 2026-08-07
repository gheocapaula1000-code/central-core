-- APPLICATA il 2026-08-07 (migration Lovable Cloud).
-- Civiko-only. La sessione PostgREST carica pg_safeupdate: gli statement DML
-- privi di WHERE dentro recompute_padova_listings_contendibili() vengono
-- rifiutati con SQLSTATE 21000 ("UPDATE requires a WHERE clause"), che PostgREST
-- traduce in HTTP 400 (step "contendibili" della chain di commissioning).
-- Patch minimale e semanticamente neutra: aggiunge "WHERE true" ai due
-- statement interessati, senza toccare la logica, le 8 zone o i dati.
DO $patch$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'recompute_padova_listings_contendibili';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'recompute_padova_listings_contendibili non trovata';
  END IF;

  IF position('ELSE agency_n_full END;' in v_def) = 0 THEN
    RAISE EXCEPTION 'anchor UPDATE _cand non trovato';
  END IF;
  IF position('DELETE FROM public.padova_contendibili_quarantena;' in v_def) = 0 THEN
    RAISE EXCEPTION 'anchor DELETE quarantena non trovato';
  END IF;

  v_new := replace(
    v_def,
    'ELSE agency_n_full END;',
    'ELSE agency_n_full END WHERE true;'
  );
  v_new := replace(
    v_new,
    'DELETE FROM public.padova_contendibili_quarantena;',
    'DELETE FROM public.padova_contendibili_quarantena WHERE true;'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'patch safeupdate non applicata';
  END IF;

  EXECUTE v_new;
END
$patch$;
