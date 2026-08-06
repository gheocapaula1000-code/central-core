-- 20260806003000_padova_contendibili_canonical_listing_identity.sql
-- P0 — Civiko One / Padova: identità canonica dell'annuncio nel certificatore
-- contendibili. Causa dei 2 falsi positivi in produzione: lo stesso annuncio
-- Idealista (stesso ID di portale) presente due volte come URL con e senza
-- slash finale, con due record e due agenzie storiche diverse, veniva contato
-- come 2 annunci di 2 agenzie distinte.
-- Correzione fail-closed, additiva, nessuna soglia modificata.

BEGIN;

-- 1) Identità canonica immutabile di un annuncio -----------------------------
CREATE OR REPLACE FUNCTION public.padova_listing_canonical_id(
  p_url   text,
  p_fonte text DEFAULT NULL
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $canon$
  WITH t AS (
    SELECT regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(lower(btrim(coalesce(p_url,''))), '[#?].*$', ''),
               '^https?://', ''),
             '^www\.', ''),
           '/+$', '') AS nu
  )
  SELECT CASE
    WHEN (SELECT nu FROM t) = '' THEN NULL
    WHEN (SELECT nu FROM t) ~ 'idealista\.[a-z.]+/immobile/[0-9]+'
      THEN 'idealista:' || substring((SELECT nu FROM t) from 'immobile/([0-9]+)')
    WHEN (SELECT nu FROM t) ~ 'casa\.it/.*immobili/[0-9]+'
      THEN 'casa:' || substring((SELECT nu FROM t) from 'immobili/([0-9]+)')
    WHEN (SELECT nu FROM t) ~ 'immobiliare\.it/annunci/[0-9]+'
      THEN 'immobiliare:' || substring((SELECT nu FROM t) from 'annunci/([0-9]+)')
    WHEN (SELECT nu FROM t) ~ 'subito\.it/.*[-/][0-9]{6,}(\.htm)?$'
      THEN 'subito:' || substring((SELECT nu FROM t) from '([0-9]{6,})(?:\.htm)?$')
    ELSE 'url:' || (SELECT nu FROM t)
  END
$canon$;

REVOKE ALL ON FUNCTION public.padova_listing_canonical_id(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.padova_listing_canonical_id(text, text) TO service_role;

COMMENT ON FUNCTION public.padova_listing_canonical_id(text, text) IS
  'Identità canonica di un annuncio: ID stabile di portale (idealista/casa/immobiliare/subito) oppure host+path normalizzati (no query, fragment, www, slash finale). Mai l''URL grezzo.';

-- 2) Test in-transaction dell''identità canonica (abortisce su fallimento) ----
DO $test$
BEGIN
  IF public.padova_listing_canonical_id('https://www.idealista.it/immobile/33268836')
     IS DISTINCT FROM public.padova_listing_canonical_id('https://www.idealista.it/immobile/33268836/') THEN
    RAISE EXCEPTION 'FAIL: slash finale cambia identità canonica';
  END IF;
  IF public.padova_listing_canonical_id('https://idealista.it/immobile/33268836/?utm_source=x#foto')
     IS DISTINCT FROM 'idealista:33268836' THEN
    RAISE EXCEPTION 'FAIL: query/fragment/www non normalizzati';
  END IF;
  IF public.padova_listing_canonical_id('https://www.casa.it/immobili/98765432/') IS DISTINCT FROM 'casa:98765432' THEN
    RAISE EXCEPTION 'FAIL: casa.it id non estratto';
  END IF;
  IF public.padova_listing_canonical_id('https://www.immobiliare.it/annunci/121212121/') IS DISTINCT FROM 'immobiliare:121212121' THEN
    RAISE EXCEPTION 'FAIL: immobiliare.it id non estratto';
  END IF;
  IF public.padova_listing_canonical_id('https://www.subito.it/appartamenti/trilocale-padova-609876543.htm?x=1') IS DISTINCT FROM 'subito:609876543' THEN
    RAISE EXCEPTION 'FAIL: subito id non estratto';
  END IF;
  IF public.padova_listing_canonical_id('https://www.idealista.it/immobile/33268836')
     = public.padova_listing_canonical_id('https://www.idealista.it/immobile/35780163') THEN
    RAISE EXCEPTION 'FAIL: due annunci realmente distinti collassati';
  END IF;
  IF public.padova_listing_canonical_id('https://www.esempio.it/annuncio/?a=1')
     IS DISTINCT FROM 'url:esempio.it/annuncio' THEN
    RAISE EXCEPTION 'FAIL: fallback host/path non normalizzato';
  END IF;
  IF public.padova_listing_canonical_id('') IS NOT NULL OR public.padova_listing_canonical_id(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: url vuoto non fail-closed';
  END IF;
  RAISE NOTICE 'padova_listing_canonical_id tests OK';
END
$test$;

-- 3) Certificatore contendibili: patch chirurgica sulla definizione LIVE ----
--    Nessuna riscrittura: si applica un patch ancorato alla definizione
--    corrente di recompute_padova_listings_contendibili(). Se un ancora non
--    esiste la migrazione abortisce (fail-closed).
DO $mig$
DECLARE
  d text;
  a text;
  b text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'recompute_padova_listings_contendibili';
  IF d IS NULL THEN
    RAISE EXCEPTION 'recompute_padova_listings_contendibili() non trovata';
  END IF;

  -- 3.1 nuova variabile di conteggio
  a := '  v_no_civico int := 0;';
  IF position(a in d) = 0 THEN RAISE EXCEPTION 'anchor v_no_civico non trovato'; END IF;
  d := replace(d, a, a || E'\n  v_dup_canonical int := 0;');

  -- 3.2 dedup canonico PRIMA di qualunque conteggio annunci/agenzie
  a := E'  CREATE TEMP TABLE _cand ON COMMIT DROP AS\n  SELECT c.*, i.identity_key\n  FROM _cand_all c\n  JOIN _identity i USING (id);\n\n  SELECT (SELECT count(*) FROM _cand_all) - (SELECT count(*) FROM _cand)\n    INTO v_excluded_no_identity;';
  IF position(a in d) = 0 THEN RAISE EXCEPTION 'anchor costruzione _cand non trovato'; END IF;
  b := E'  -- canonical-listing-dedup-v1: identita canonica dell''annuncio PRIMA di\n'
    || E'  -- qualunque conteggio di annunci/agenzie. Lo stesso annuncio canonico\n'
    || E'  -- (stesso ID di portale; URL con/senza slash, query, fragment o www)\n'
    || E'  -- contribuisce una sola riga: la piu recente (last_seen_at, poi id).\n'
    || E'  CREATE TEMP TABLE _cand_dup ON COMMIT DROP AS\n'
    || E'  SELECT c.*, i.identity_key,\n'
    || E'         public.padova_listing_canonical_id(c.url, c.fonte) AS canonical_listing_id\n'
    || E'  FROM _cand_all c\n'
    || E'  JOIN _identity i USING (id);\n\n'
    || E'  SELECT (SELECT count(*) FROM _cand_all) - (SELECT count(*) FROM _cand_dup)\n'
    || E'    INTO v_excluded_no_identity;\n\n'
    || E'  CREATE TEMP TABLE _cand ON COMMIT DROP AS\n'
    || E'  SELECT z.* FROM (\n'
    || E'    SELECT d.*, row_number() OVER (\n'
    || E'             PARTITION BY d.canonical_listing_id\n'
    || E'             ORDER BY d.l_last_seen_at DESC NULLS LAST, d.id DESC) AS _rn\n'
    || E'      FROM _cand_dup d\n'
    || E'     WHERE d.canonical_listing_id IS NOT NULL\n'
    || E'  ) z\n'
    || E'  WHERE z._rn = 1;\n\n'
    || E'  ALTER TABLE _cand DROP COLUMN _rn;\n\n'
    || E'  SELECT (SELECT count(*) FROM _cand_dup) - (SELECT count(*) FROM _cand)\n'
    || E'    INTO v_dup_canonical;';
  d := replace(d, a, b);

  -- 3.3 propagazione dell'identita canonica nello staging di unita
  a := E'         c.agency_key, c.agency_raw, c.l_last_seen_at,';
  IF position(a in d) = 0 THEN RAISE EXCEPTION 'anchor _unit non trovato'; END IF;
  d := replace(d, a, E'         c.agency_key, c.agency_raw, c.l_last_seen_at, c.canonical_listing_id,');

  -- 3.4 conteggio identita canoniche per gruppo
  a := E'    count(*) AS n_rows,\n    count(DISTINCT agency_key) AS n_agenzie,';
  IF position(a in d) = 0 THEN RAISE EXCEPTION 'anchor _unit_grp non trovato'; END IF;
  d := replace(d, a, E'    count(*) AS n_rows,\n    count(DISTINCT canonical_listing_id) AS n_annunci_canonici,\n    count(DISTINCT agency_key) AS n_agenzie,');

  -- 3.5 vincolo di certificazione: >= 2 identita canoniche
  a := E'  WHERE n_agenzie >= 2\n    AND n_rows BETWEEN 2 AND 8';
  IF position(a in d) = 0 THEN RAISE EXCEPTION 'anchor _unit_ok non trovato'; END IF;
  d := replace(d, a, E'  WHERE n_agenzie >= 2\n    AND n_annunci_canonici >= 2\n    AND n_rows BETWEEN 2 AND 8');

  -- 3.6 QA staging
  a := E'  SELECT count(*) INTO v_bad FROM _cert\n   WHERE n_agenzie < 2';
  IF position(a in d) = 0 THEN RAISE EXCEPTION 'anchor QA staging non trovato'; END IF;
  d := replace(d, a, a || E'\n      OR coalesce(n_annunci_canonici, 0) < 2');

  -- 3.7 QA post-pubblicazione (rollback totale su violazione)
  a := E'  SELECT count(*) INTO v_cont_after FROM public.padova_contendibili;';
  IF position(a in d) = 0 THEN RAISE EXCEPTION 'anchor QA post-pubblicazione non trovato'; END IF;
  b := E'  SELECT count(*) INTO v_bad\n'
    || E'    FROM public.padova_contendibili pc\n'
    || E'   WHERE (\n'
    || E'     SELECT count(DISTINCT public.padova_listing_canonical_id(u, NULL))\n'
    || E'       FROM unnest(coalesce(pc.urls, ARRAY[]::text[])) AS u\n'
    || E'   ) < 2;\n'
    || E'  IF v_bad > 0 THEN\n'
    || E'    RAISE EXCEPTION ''QA identita canonica fallita: % contendibili con meno di 2 annunci canonici distinti'', v_bad;\n'
    || E'  END IF;\n\n' || a;
  d := replace(d, a, b);

  -- 3.8 metrica di ritorno
  a := E'    ''righe_senza_civico'', v_no_civico,';
  IF position(a in d) = 0 THEN RAISE EXCEPTION 'anchor metriche non trovato'; END IF;
  d := replace(d, a, a || E'\n    ''duplicati_canonici_rimossi'', v_dup_canonical,');

  IF position('canonical-listing-dedup-v1' in d) = 0
     OR position('n_annunci_canonici >= 2' in d) = 0
     OR position('QA identita canonica fallita' in d) = 0 THEN
    RAISE EXCEPTION 'patch canonical-listing-dedup-v1 non applicata';
  END IF;

  EXECUTE d;
END
$mig$;

COMMIT;