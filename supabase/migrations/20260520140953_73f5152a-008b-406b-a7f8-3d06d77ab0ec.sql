
CREATE TABLE IF NOT EXISTS public.padova_civici (
  id BIGSERIAL PRIMARY KEY,
  comune TEXT NOT NULL DEFAULT 'Padova',
  provincia TEXT NOT NULL DEFAULT 'PD',
  street_name TEXT NOT NULL,
  street_name_normalized TEXT NOT NULL,
  civic_number TEXT NOT NULL,
  civic_suffix TEXT,
  cap TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  quartiere TEXT,
  microzona TEXT,
  omi_zone TEXT,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  license TEXT,
  quality TEXT NOT NULL DEFAULT 'parziale',
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  fingerprint TEXT NOT NULL UNIQUE,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_padova_civici_street ON public.padova_civici(street_name_normalized);
CREATE INDEX IF NOT EXISTS idx_padova_civici_cap ON public.padova_civici(cap);
CREATE INDEX IF NOT EXISTS idx_padova_civici_microzona ON public.padova_civici(microzona);
CREATE INDEX IF NOT EXISTS idx_padova_civici_omi ON public.padova_civici(omi_zone);

ALTER TABLE public.padova_civici ENABLE ROW LEVEL SECURITY;

CREATE POLICY public_read_padova_civici ON public.padova_civici FOR SELECT TO public USING (true);
CREATE POLICY service_role_full_padova_civici ON public.padova_civici FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.opportunity_evidence
  ADD COLUMN IF NOT EXISTS source_unverified BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.resolve_padova_geo_level(p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION)
RETURNS TABLE(geo_level TEXT, omi_zone TEXT, microzona TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_omi RECORD;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL THEN
    RETURN QUERY SELECT 'city_level'::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  SELECT z.zona, z.zona_descr INTO v_omi
  FROM public.omi_zone_geometry z
  WHERE z.comune_descrizione ILIKE 'padova'
    AND extensions.ST_Contains(z.geom, extensions.ST_SetSRID(extensions.ST_Point(p_lng, p_lat), 4326))
  LIMIT 1;
  IF v_omi.zona IS NOT NULL THEN
    RETURN QUERY SELECT 'microzone'::TEXT, v_omi.zona, v_omi.zona_descr;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'city_level'::TEXT, NULL::TEXT, NULL::TEXT;
END $$;
