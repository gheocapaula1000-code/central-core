-- Civiko-only. Secondo statement DML privo di WHERE nella catena contendibili:
-- padova_certify_multi_portale() → DELETE FROM padova_multi_portale_quarantena.
-- pg_safeupdate (sessione PostgREST) lo rifiuta con SQLSTATE 21000.
DO $patch$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'padova_certify_multi_portale';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'padova_certify_multi_portale non trovata';
  END IF;
  IF position('DELETE FROM public.padova_multi_portale_quarantena;' in v_def) = 0 THEN
    RAISE EXCEPTION 'anchor DELETE quarantena multi_portale non trovato';
  END IF;

  v_new := replace(
    v_def,
    'DELETE FROM public.padova_multi_portale_quarantena;',
    'DELETE FROM public.padova_multi_portale_quarantena WHERE true;'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'patch safeupdate multi_portale non applicata';
  END IF;

  EXECUTE v_new;
END
$patch$;