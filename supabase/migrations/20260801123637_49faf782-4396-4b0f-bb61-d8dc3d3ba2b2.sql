
DO $patch$
DECLARE
  src text;
  orig text;
  n int := 0;
  r1 constant text := $r1$    AND p.indirizzo IS NOT NULL
    AND public.norm_via(p.indirizzo) NOT IN ('','na')$r1$;
  r2 constant text := 'p.lat, p.lng, p.quartiere, p.indirizzo, p.agency, p.last_seen_at AS l_last_seen_at,';
  r3 constant text := 'public.norm_via(p.indirizzo) AS via_n,';
  r4 constant text := ') AS civico_n,';
  r5 constant text := 'public.padova_unit_floor_key(l.raw_json) AS piano_k,';
  r6 constant text := $r6$CASE WHEN length(regexp_replace(lower(COALESCE(l.raw_json->>'description', l.raw_json->>'body','')), '[^a-z0-9]+','','g')) >= 160$r6$;
  r7 constant text := 'END AS descr_fp,';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'recompute_padova_listings_contendibili';
  IF src IS NULL THEN RAISE EXCEPTION 'recompute function not found'; END IF;
  orig := src;

  IF position(r1 in src) = 0 THEN RAISE EXCEPTION 'anchor r1 missing'; END IF;
  src := replace(src, r1,
    '    AND COALESCE(p.ev_via_norm, public.padova_via_key(p.indirizzo)) IS NOT NULL');

  IF position(r2 in src) = 0 THEN RAISE EXCEPTION 'anchor r2 missing'; END IF;
  src := replace(src, r2, r2 || ' p.ev_via_norm, p.ev_civico_norm,');

  IF position(r3 in src) = 0 THEN RAISE EXCEPTION 'anchor r3 missing'; END IF;
  src := replace(src, r3,
    'COALESCE(p.ev_via_norm, public.padova_via_key(p.indirizzo)) AS via_n,');

  IF position(r4 in src) = 0 THEN RAISE EXCEPTION 'anchor r4 missing'; END IF;
  src := replace(src, r4, ') AS civico_legacy, COALESCE(p.ev_civico_norm, '''') AS civico_n,');

  IF position(r5 in src) = 0 THEN RAISE EXCEPTION 'anchor r5 missing'; END IF;
  src := replace(src, r5,
    'COALESCE(l.ev_piano_key, public.padova_unit_floor_key_v2(l.raw_json)) AS piano_k,');

  IF position(r6 in src) = 0 THEN RAISE EXCEPTION 'anchor r6 missing'; END IF;
  src := replace(src, r6, 'COALESCE(l.ev_descr_fp, ' || r6);

  IF position(r7 in src) = 0 THEN RAISE EXCEPTION 'anchor r7 missing'; END IF;
  src := replace(src, r7, 'END) AS descr_fp,');

  IF src = orig THEN RAISE EXCEPTION 'no patch applied'; END IF;
  EXECUTE src;
END
$patch$;

-- Backfill iniziale a lotti (idempotente, solo da dati già presenti)
DO $bf$
DECLARE i int; res jsonb;
BEGIN
  FOR i IN 1..6 LOOP
    res := public.padova_backfill_unit_evidence(2000, true);
    EXIT WHEN (res->>'remaining')::int = 0 AND i > 1;
  END LOOP;
END
$bf$;
