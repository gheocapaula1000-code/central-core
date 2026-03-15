-- Enable PostGIS
CREATE EXTENSION IF NOT EXISTS postgis SCHEMA extensions;

-- OMI zone geometry table for point-in-polygon lookups
CREATE TABLE IF NOT EXISTS public.omi_zone_geometry (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  link_zona text NOT NULL,
  zona text NOT NULL,
  zona_descr text,
  comune_istat text NOT NULL,
  comune_descrizione text NOT NULL,
  provincia text NOT NULL,
  geom extensions.geometry(MultiPolygon, 4326) NOT NULL,
  semestre text DEFAULT '2025/1',
  created_at timestamptz DEFAULT now()
);

-- Spatial index for fast point-in-polygon
CREATE INDEX IF NOT EXISTS idx_omi_zone_geometry_geom ON public.omi_zone_geometry USING GIST (geom);
-- Index for join with omi_valori
CREATE INDEX IF NOT EXISTS idx_omi_zone_geometry_link_zona ON public.omi_zone_geometry (link_zona);

-- RLS: public read
ALTER TABLE public.omi_zone_geometry ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_omi_zone_geometry" ON public.omi_zone_geometry FOR SELECT TO public USING (true);

-- RPC: point-in-polygon lookup returning matching OMI zones
CREATE OR REPLACE FUNCTION public.omi_zone_by_point(p_lat double precision, p_lng double precision)
RETURNS TABLE (
  link_zona text,
  zona text,
  zona_descr text,
  comune_istat text,
  comune_descrizione text,
  provincia text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    g.link_zona,
    g.zona,
    g.zona_descr,
    g.comune_istat,
    g.comune_descrizione,
    g.provincia
  FROM public.omi_zone_geometry g
  WHERE extensions.ST_Contains(g.geom, extensions.ST_SetSRID(extensions.ST_Point(p_lng, p_lat), 4326))
  LIMIT 5;
$$;
