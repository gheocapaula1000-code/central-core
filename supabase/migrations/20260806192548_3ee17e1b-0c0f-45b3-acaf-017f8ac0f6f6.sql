-- CIVIKO ONLY — G19: commercial_zone_slug persistito sui cambi agenzia.

ALTER TABLE public.padova_cambi_agenzia
  ADD COLUMN IF NOT EXISTS commercial_zone_slug text;

-- Risolutore autorevole: annuncio corrispondente (slug persistito) e, in
-- assenza, risolutore ufficiale sul quartiere. Solo le 8 zone ufficiali.
CREATE OR REPLACE FUNCTION public.civiko_cambi_zone_slug(_curl text, _quartiere text)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT s FROM (
    SELECT COALESCE(
      (SELECT p.commercial_zone_slug
         FROM public.padova_listings p
        WHERE _curl IS NOT NULL
          AND public.canon_url(p.url) = _curl
          AND p.commercial_zone_slug IS NOT NULL
        ORDER BY p.last_seen_at DESC NULLS LAST, p.id DESC
        LIMIT 1),
      public.civiko_resolve_commercial_zone_slug(_quartiere)
    ) AS s
  ) q
  WHERE s IN (
    'centro-storico','est-brenta','est-forcellini-camin','nord-arcella',
    'ovest-chiesanuova-brentelle','sud-est-sant-osvaldo','sud-ovest-mandria',
    'sud-voltabarozzo-guizza');
$function$;

REVOKE ALL ON FUNCTION public.civiko_cambi_zone_slug(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.civiko_cambi_zone_slug(text, text) TO service_role;

UPDATE public.padova_cambi_agenzia c
   SET commercial_zone_slug = public.civiko_cambi_zone_slug(c.canon_url, c.quartiere)
 WHERE c.commercial_zone_slug IS NULL;

CREATE INDEX IF NOT EXISTS padova_cambi_agenzia_zone_active_idx
  ON public.padova_cambi_agenzia (commercial_zone_slug, data_cambio DESC)
  WHERE is_active;

-- Vista di zona: legge il campo PERSISTITO, non un ricalcolo per lettura.
CREATE OR REPLACE VIEW public.padova_cambi_agenzia_by_zone_v AS
 SELECT id, canon_url, portale, agenzia_precedente, agenzia_nuova, data_cambio,
        titolo, indirizzo, quartiere, zona_omi, prezzo_eur, mq, locali,
        first_detected_at, last_seen_at, is_active, contendibile_overlap,
        created_at, updated_at, commercial_zone_slug
   FROM public.padova_cambi_agenzia c;

-- Patch fail-closed della definizione installata del rilevatore.
DO $patch$
DECLARE d text; d0 text; o text; n text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
    JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
   WHERE nsp.nspname='public' AND p.proname='detect_padova_cambio_agenzia';
  IF d IS NULL THEN
    RAISE EXCEPTION 'patch: detect_padova_cambio_agenzia non installata';
  END IF;
  d0 := d;

  o := $r1$      titolo, indirizzo, quartiere, zona_omi, prezzo_eur, mq, locali,
      contendibile_overlap
    )$r1$;
  n := $r2$      titolo, indirizzo, quartiere, zona_omi, prezzo_eur, mq, locali,
      contendibile_overlap, commercial_zone_slug
    )$r2$;
  IF position(o IN d) = 0 THEN
    RAISE EXCEPTION 'patch: elenco colonne INSERT atteso non trovato';
  END IF;
  d := replace(d, o, n);

  o := $r3$      s.prezzo, s.mq, s.locali,
      (o.curl IS NOT NULL)$r3$;
  n := $r4$      s.prezzo, s.mq, s.locali,
      (o.curl IS NOT NULL),
      public.civiko_cambi_zone_slug(ch.curl, s.quartiere)$r4$;
  IF position(o IN d) = 0 THEN
    RAISE EXCEPTION 'patch: proiezione INSERT attesa non trovata';
  END IF;
  d := replace(d, o, n);

  o := $r5$          contendibile_overlap = EXCLUDED.contendibile_overlap,
          is_active            = true$r5$;
  n := $r6$          contendibile_overlap = EXCLUDED.contendibile_overlap,
          commercial_zone_slug = COALESCE(EXCLUDED.commercial_zone_slug,
                                          pca.commercial_zone_slug),
          is_active            = true$r6$;
  IF position(o IN d) = 0 THEN
    RAISE EXCEPTION 'patch: blocco ON CONFLICT atteso non trovato';
  END IF;
  d := replace(d, o, n);

  IF d = d0 THEN
    RAISE EXCEPTION 'patch: nessuna modifica applicata';
  END IF;
  EXECUTE d;
END
$patch$;

DO $verify$
DECLARE d text; v_bad bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='padova_cambi_agenzia'
       AND column_name='commercial_zone_slug'
  ) THEN
    RAISE EXCEPTION 'verifica: colonna commercial_zone_slug assente';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
    JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
   WHERE nsp.nspname='public' AND p.proname='detect_padova_cambio_agenzia';
  IF position('civiko_cambi_zone_slug' IN d) = 0 THEN
    RAISE EXCEPTION 'verifica: rilevatore non scrive la zona commerciale';
  END IF;

  IF position('civiko_resolve_commercial_zone_slug'
              IN pg_get_viewdef('public.padova_cambi_agenzia_by_zone_v'::regclass)) > 0 THEN
    RAISE EXCEPTION 'verifica: la vista ricalcola ancora la zona per lettura';
  END IF;

  SELECT count(*) INTO v_bad FROM public.padova_cambi_agenzia
   WHERE commercial_zone_slug IS NOT NULL
     AND commercial_zone_slug NOT IN (
       'centro-storico','est-brenta','est-forcellini-camin','nord-arcella',
       'ovest-chiesanuova-brentelle','sud-est-sant-osvaldo','sud-ovest-mandria',
       'sud-voltabarozzo-guizza');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'verifica: % cambi con zona fuori contratto', v_bad;
  END IF;
END
$verify$;