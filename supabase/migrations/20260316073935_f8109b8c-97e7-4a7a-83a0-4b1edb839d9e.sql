
-- RPC: insert a single OMI zone geometry from GeoJSON
-- Used by the omi-geometry-import edge function
CREATE OR REPLACE FUNCTION public.insert_omi_geometry(
  p_link_zona text,
  p_zona text,
  p_zona_descr text,
  p_comune_istat text,
  p_comune_descrizione text,
  p_provincia text,
  p_geojson text,
  p_semestre text DEFAULT '2025/1'
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.omi_zone_geometry (link_zona, zona, zona_descr, comune_istat, comune_descrizione, provincia, geom, semestre)
  VALUES (
    p_link_zona,
    p_zona,
    p_zona_descr,
    p_comune_istat,
    p_comune_descrizione,
    p_provincia,
    extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(p_geojson), 4326),
    p_semestre
  )
  RETURNING id;
$$;

-- RPC: clear all geometry data (for re-import)
CREATE OR REPLACE FUNCTION public.clear_omi_geometry()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.omi_zone_geometry;
$$;
