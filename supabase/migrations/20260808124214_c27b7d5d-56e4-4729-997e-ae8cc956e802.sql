-- Civiko P0 — risoluzione zona fail-closed per il percorso pubblicabile.
-- Nessuna invenzione: solo quartieri risolvibili dal contratto 8 zone.

CREATE OR REPLACE FUNCTION public.civiko_padova_listings_zone_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_slug text;
BEGIN
  -- Fuori Comune di Padova: nessuna zona commerciale ammessa nel percorso
  -- pubblicabile. Il record resta, ma in quarantena territoriale.
  IF NEW.comune IS NOT NULL AND btrim(NEW.comune) <> ''
     AND NOT public.civiko_is_comune_padova(NEW.comune) THEN
    NEW.commercial_zone_slug  := NULL;
    NEW.zone_match_method     := 'out_of_comune_quarantine';
    NEW.zone_match_confidence := NULL;
    NEW.zone_resolved_at      := now();
    RETURN NEW;
  END IF;

  IF NEW.quartiere IS NOT NULL AND btrim(NEW.quartiere) <> '' THEN
    v_slug := public.civiko_resolve_commercial_zone_slug(NEW.quartiere);
    IF v_slug IS NOT NULL THEN
      NEW.commercial_zone_slug  := v_slug;
      NEW.zone_match_method     := 'quartiere_contract_v1';
      NEW.zone_match_confidence := 1;
      NEW.zone_resolved_at      := now();
      RETURN NEW;
    END IF;
  END IF;

  -- Quartiere assente, generico o composto ambiguo: preserva solo uno slug
  -- assegnato esplicitamente (backfill GPS via PIP OMI). Altrimenti resta NULL.
  IF NEW.commercial_zone_slug IS NOT NULL AND NEW.zone_match_method IS NULL THEN
    NEW.zone_match_method     := 'gps_pip_omi';
    NEW.zone_match_confidence := 0.8;
    NEW.zone_resolved_at      := now();
  END IF;
  RETURN NEW;
END
$function$;

DO $$
DECLARE
  v_before_null int;
  v_before_out int;
  v_resolved int := 0;
  v_cleared int := 0;
  v_after_null int;
BEGIN
  SELECT count(*) INTO v_before_null
  FROM public.padova_listings
  WHERE expired_at IS NULL AND commercial_zone_slug IS NULL;

  SELECT count(*) INTO v_before_out
  FROM public.padova_listings
  WHERE expired_at IS NULL AND commercial_zone_slug IS NOT NULL
    AND comune IS NOT NULL AND btrim(comune) <> ''
    AND NOT public.civiko_is_comune_padova(comune);

  -- 1) Risoluzione dei soli quartieri non ambigui, dentro il Comune di Padova.
  WITH upd AS (
    UPDATE public.padova_listings l
       SET commercial_zone_slug  = public.civiko_resolve_commercial_zone_slug(l.quartiere),
           zone_match_method     = 'quartiere_contract_v1',
           zone_match_confidence = 1,
           zone_resolved_at      = now()
     WHERE l.expired_at IS NULL
       AND l.commercial_zone_slug IS NULL
       AND l.quartiere IS NOT NULL AND btrim(l.quartiere) <> ''
       AND public.civiko_is_comune_padova(coalesce(l.comune, 'Padova'))
       AND public.civiko_resolve_commercial_zone_slug(l.quartiere) IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_resolved FROM upd;

  -- 2) Fuori Comune: nessuna zona nel percorso pubblicabile.
  WITH cle AS (
    UPDATE public.padova_listings l
       SET commercial_zone_slug  = NULL,
           zone_match_method     = 'out_of_comune_quarantine',
           zone_match_confidence = NULL,
           zone_resolved_at      = now()
     WHERE l.commercial_zone_slug IS NOT NULL
       AND l.comune IS NOT NULL AND btrim(l.comune) <> ''
       AND NOT public.civiko_is_comune_padova(l.comune)
    RETURNING 1
  )
  SELECT count(*) INTO v_cleared FROM cle;

  SELECT count(*) INTO v_after_null
  FROM public.padova_listings
  WHERE expired_at IS NULL AND commercial_zone_slug IS NULL;

  RAISE NOTICE 'civiko_zone_fix before_null=% before_out=% resolved=% cleared=% after_null=%',
    v_before_null, v_before_out, v_resolved, v_cleared, v_after_null;
END $$;