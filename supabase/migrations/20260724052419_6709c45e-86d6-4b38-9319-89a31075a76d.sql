
CREATE OR REPLACE FUNCTION public.civiko_padova_listings_zone_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_slug text;
BEGIN
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

  -- Quartiere assente o non risolvibile: preserva l'eventuale slug assegnato
  -- esplicitamente (es. backfill GPS via PIP OMI). Se NEW.commercial_zone_slug
  -- e' NULL, resta NULL — nessuna invenzione.
  IF NEW.commercial_zone_slug IS NOT NULL AND NEW.zone_match_method IS NULL THEN
    NEW.zone_match_method     := 'gps_pip_omi';
    NEW.zone_match_confidence := 0.8;
    NEW.zone_resolved_at      := now();
  END IF;
  RETURN NEW;
END
$$;

-- Backfill PIP GPS
WITH labeled AS (
  SELECT l.commercial_zone_slug AS slug, g.zona AS omi_zona
  FROM public.padova_listings l
  JOIN public.omi_zone_geometry g
    ON g.comune_descrizione ILIKE 'padova'
   AND extensions.ST_Contains(g.geom, extensions.ST_SetSRID(extensions.ST_MakePoint(l.lng::float8, l.lat::float8), 4326))
  WHERE l.comune='Padova' AND l.commercial_zone_slug IS NOT NULL AND l.lat IS NOT NULL AND l.lng IS NOT NULL
),
counts AS (SELECT omi_zona, slug, COUNT(*) c FROM labeled GROUP BY 1,2),
mode_map AS (SELECT DISTINCT ON (omi_zona) omi_zona, slug FROM counts ORDER BY omi_zona, c DESC)
UPDATE public.padova_listings l
SET commercial_zone_slug = mm.slug,
    zone_match_method = 'gps_pip_omi',
    zone_match_confidence = 0.8,
    zone_resolved_at = now()
FROM public.omi_zone_geometry g, mode_map mm
WHERE l.comune='Padova' AND l.expired_at IS NULL AND l.commercial_zone_slug IS NULL
  AND l.lat IS NOT NULL AND l.lng IS NOT NULL
  AND g.comune_descrizione ILIKE 'padova'
  AND extensions.ST_Contains(g.geom, extensions.ST_SetSRID(extensions.ST_MakePoint(l.lng::float8, l.lat::float8), 4326))
  AND mm.omi_zona = g.zona;
