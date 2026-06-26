
-- Funzione di breakdown OMI per Padova (point-in-polygon su listing_price_snapshots).
-- Ritorna una riga per zona OMI ufficiale (22) con il count di snapshot
-- ricaduti nella zona dall'istante `p_since` ad ora.
CREATE OR REPLACE FUNCTION public.padova_omi_snapshot_breakdown(p_since timestamptz)
RETURNS TABLE (
  omi_zone_code text,
  fascia text,
  zona_descr text,
  snapshot_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH zones AS (
    SELECT DISTINCT ON (z.zona)
      z.zona AS omi_zone_code,
      z.fascia,
      z.zona_descr,
      g.geom
    FROM public.omi_zone z
    JOIN public.omi_zone_geometry g ON g.link_zona = z.link_zona
    WHERE z.comune_descrizione = 'PADOVA'
    ORDER BY z.zona, z.semestre DESC
  ),
  snaps AS (
    SELECT lat, lng
    FROM public.listing_price_snapshots
    WHERE created_at >= p_since
      AND lat IS NOT NULL
      AND lng IS NOT NULL
      AND lower(municipality) = 'padova'
  )
  SELECT
    z.omi_zone_code,
    z.fascia,
    z.zona_descr,
    COUNT(s.*)::bigint AS snapshot_count
  FROM zones z
  LEFT JOIN snaps s
    ON extensions.ST_Contains(
         z.geom,
         extensions.ST_SetSRID(extensions.ST_MakePoint(s.lng, s.lat), 4326)
       )
  GROUP BY z.omi_zone_code, z.fascia, z.zona_descr
  ORDER BY z.omi_zone_code;
$$;

REVOKE ALL ON FUNCTION public.padova_omi_snapshot_breakdown(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.padova_omi_snapshot_breakdown(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.padova_omi_snapshot_breakdown(timestamptz) TO authenticated;
