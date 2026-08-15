CREATE OR REPLACE FUNCTION public.civiko_padova_listings_zone_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_slug text;
  v_n    int;
BEGIN
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

  -- Passo indirizzo_segment_contract_v1: risolve la zona dai segmenti
  -- dell'indirizzo separati da virgola, usando SOLO il contratto ufficiale
  -- quartiere -> zona. Fail-closed: se i segmenti riconosciuti puntano a
  -- zone diverse (ambiguità) non si assegna nulla. Nessuna inferenza fuzzy.
  IF NEW.indirizzo IS NOT NULL AND btrim(NEW.indirizzo) <> '' THEN
    SELECT count(DISTINCT s), min(s) INTO v_n, v_slug
    FROM (
      SELECT public.civiko_resolve_commercial_zone_slug(btrim(x)) AS s
      FROM unnest(string_to_array(NEW.indirizzo, ',')) AS x
    ) t
    WHERE s IS NOT NULL;

    IF v_n = 1 AND v_slug IS NOT NULL THEN
      NEW.commercial_zone_slug  := v_slug;
      NEW.zone_match_method     := 'indirizzo_segment_contract_v1';
      NEW.zone_match_confidence := 0.9;
      NEW.zone_resolved_at      := now();
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.commercial_zone_slug IS NOT NULL AND NEW.zone_match_method IS NULL THEN
    NEW.zone_match_method     := 'gps_pip_omi';
    NEW.zone_match_confidence := 0.8;
    NEW.zone_resolved_at      := now();
  END IF;
  RETURN NEW;
END
$function$;