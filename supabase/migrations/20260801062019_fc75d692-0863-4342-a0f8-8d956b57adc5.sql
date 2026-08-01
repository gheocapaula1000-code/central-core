-- CHECKPOINT P0-B — ESCLUSIONE ASTE DAI CONTENDIBILI

CREATE OR REPLACE FUNCTION public.padova_listing_has_auction_evidence(
  p_raw jsonb,
  p_agency text DEFAULT NULL
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public'
AS $fn$
WITH src AS (
  SELECT
    lower(coalesce(p_raw->>'rty','')) AS rty,
    lower(coalesce(p_raw->>'contract','')) AS contract,
    lower(coalesce(p_raw->>'typology','')) AS typology,
    lower(coalesce(p_raw->>'saleType','')) AS sale_type,
    lower(coalesce(p_raw->>'tipo_vendita','')) AS tipo_vendita,
    lower(coalesce(p_raw->>'auction','')) AS auction_field,
    translate(lower(
      coalesce(p_raw->>'title','')                                   || ' ' ||
      coalesce(p_raw->'suggestedTexts'->>'title','')                 || ' ' ||
      coalesce(p_raw->>'subject','')                                 || ' ' ||
      coalesce(p_raw->>'notes','')                                   || ' ' ||
      CASE jsonb_typeof(p_raw->'description')
        WHEN 'object' THEN coalesce(p_raw->'description'->>'content','') || ' ' ||
                           coalesce(p_raw->'description'->>'caption','')
        WHEN 'string' THEN coalesce(p_raw->>'description','')
        ELSE ''
      END                                                            || ' ' ||
      coalesce(p_raw->>'body','')
    ), 'àáâäèéêëìíîïòóôöùúûüç', 'aaaaeeeeiiiioooouuuuc') AS txt,
    translate(lower(coalesce(p_agency,'')),
      'àáâäèéêëìíîïòóôöùúûüç', 'aaaaeeeeiiiioooouuuuc') AS agency_txt
)
SELECT
  s.rty = 'as'
  OR s.auction_field IN ('true','1','yes','si')
  OR s.contract ~ '(asta|auction|giudizia)'
  OR s.typology ~ '(asta|auction|giudizia)'
  OR s.sale_type ~ '(asta|auction|giudizia)'
  OR s.tipo_vendita ~ '(asta|auction|giudizia)'
  OR s.txt ~ '(^|[^a-z0-9])(aste?|pre[- ]?aste?|auction)([^a-z0-9]|$)'
  OR s.txt ~ 'giudiziar'
  OR s.txt ~ 'esecuzion[ei] immobiliar'
  OR s.txt ~ 'procedur[ae] esecutiv'
  OR s.txt ~ '(^|[^a-z0-9])tribunale([^a-z0-9]|$)'
  OR s.txt ~ '(^|[^a-z0-9])lott[oi]([^a-z0-9]|$)'
  OR s.txt ~ 'base d.?asta'
  OR s.txt ~ 'offerta minima'
  OR s.txt ~ 'senza incanto'
  OR s.txt ~ '(^|[^a-z0-9])r\.?g\.?e\.?([^a-z0-9]|$)'
  OR s.txt ~ 'custode giudiziario'
  OR s.txt ~ 'delegato alla vendita'
  OR s.txt ~ 'pignoram'
  OR s.txt ~ 'fallimentar'
  OR s.txt ~ 'concordato preventivo'
  OR (
    s.agency_txt ~ '(^|[^a-z0-9])(aste?|asta)([^a-z0-9]|$)'
    AND s.txt ~ '(procedur|giudizi|tribunal|esecutiv|incanto|perizia)'
  )
FROM src s;
$fn$;

REVOKE ALL ON FUNCTION public.padova_listing_has_auction_evidence(jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.padova_listing_has_auction_evidence(jsonb, text) TO service_role;

COMMENT ON FUNCTION public.padova_listing_has_auction_evidence(jsonb, text) IS
  'True se annuncio con evidenza oggettiva di asta o procedura giudiziaria (campi strutturati o testo normalizzato). Il nome agenzia da solo non e mai prova sufficiente.';

DO $patch$
DECLARE
  src text;
  out text;
  nl  text := chr(10);
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'recompute_padova_listings_contendibili';

  IF src IS NULL THEN
    RAISE EXCEPTION 'recompute_padova_listings_contendibili non trovata';
  END IF;

  out := src;

  out := replace(out,
    '  v_bad int;' || nl,
    '  v_bad int;' || nl || '  v_asta_rows int := 0;' || nl || '  v_asta_groups int := 0;' || nl);

  out := replace(out,
    '  SELECT count(*) INTO v_prefilter FROM _cand;' || nl,
    '  SELECT count(*) INTO v_prefilter FROM _cand;' || nl || nl ||
    '  CREATE TEMP TABLE _asta_urls ON COMMIT DROP AS' || nl ||
    '  SELECT DISTINCT c.url' || nl ||
    '  FROM _cand c' || nl ||
    '  JOIN public.padova_listings l ON l.id = c.id' || nl ||
    '  WHERE public.padova_listing_has_auction_evidence(l.raw_json, c.agency_raw);' || nl ||
    '  SELECT count(*) INTO v_asta_rows FROM _asta_urls;' || nl);

  out := replace(out,
    '  FROM _unit_ev' || nl || '  GROUP BY 1,2,3,4,5,6,7;' || nl,
    '  FROM _unit_ev' || nl || '  GROUP BY 1,2,3,4,5,6,7;' || nl || nl ||
    '  SELECT count(*) INTO v_asta_groups FROM _unit_grp g' || nl ||
    '   WHERE EXISTS (SELECT 1 FROM _asta_urls a WHERE a.url = ANY(g.urls));' || nl ||
    '  DELETE FROM _unit_grp g' || nl ||
    '   WHERE EXISTS (SELECT 1 FROM _asta_urls a WHERE a.url = ANY(g.urls));' || nl);

  out := replace(out,
    '        ''EVIDENZA_UNITA_ASSENTE''' || nl,
    '        CASE WHEN bool_or(public.padova_listing_has_auction_evidence(l.raw_json, g.agency_raw))' || nl ||
    '             THEN ''ASTA_O_PROCEDURA'' END,' || nl ||
    '        ''EVIDENZA_UNITA_ASSENTE''' || nl);

  out := replace(out,
    '  SELECT count(*) INTO v_cont_after FROM public.padova_contendibili;' || nl,
    '  SELECT count(*) INTO v_bad' || nl ||
    '    FROM public.padova_contendibili pc' || nl ||
    '   WHERE EXISTS (' || nl ||
    '     SELECT 1 FROM public.padova_listings l' || nl ||
    '      WHERE l.url = ANY(pc.urls)' || nl ||
    '        AND public.padova_listing_has_auction_evidence(l.raw_json, l.agency));' || nl ||
    '  IF v_bad > 0 THEN' || nl ||
    '    RAISE EXCEPTION ''QA aste fallita: % contendibili con evidenza asta'', v_bad;' || nl ||
    '  END IF;' || nl || nl ||
    '  SELECT count(*) INTO v_cont_after FROM public.padova_contendibili;' || nl);

  out := replace(out,
    '    ''ok'', true,' || nl,
    '    ''ok'', true,' || nl ||
    '    ''aste_annunci_esclusi'', v_asta_rows,' || nl ||
    '    ''aste_gruppi_esclusi'', v_asta_groups,' || nl);

  IF position('_asta_urls' in out) = 0
     OR position('ASTA_O_PROCEDURA' in out) = 0
     OR position('QA aste fallita' in out) = 0
     OR position('aste_gruppi_esclusi' in out) = 0 THEN
    RAISE EXCEPTION 'Patch aste non applicata integralmente';
  END IF;

  EXECUTE out;
END;
$patch$;

CREATE OR REPLACE VIEW public.padova_contendibili_by_zone_v AS
SELECT pc.*
FROM public.padova_contendibili pc
WHERE NOT EXISTS (
  SELECT 1 FROM public.padova_listings l
   WHERE l.url = ANY(pc.urls)
     AND public.padova_listing_has_auction_evidence(l.raw_json, l.agency)
);

REVOKE ALL ON public.padova_contendibili_by_zone_v FROM PUBLIC;
REVOKE ALL ON public.padova_contendibili_by_zone_v FROM anon;
REVOKE ALL ON public.padova_contendibili_by_zone_v FROM authenticated;
GRANT SELECT ON public.padova_contendibili_by_zone_v TO service_role;

COMMENT ON VIEW public.padova_contendibili_by_zone_v IS
  'Server-only. Contendibili certificati v3, con difesa aggiuntiva: esclude ogni gruppo che contenga almeno un annuncio con evidenza di asta o procedura giudiziaria. Accesso: service_role.';