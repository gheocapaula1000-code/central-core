CREATE OR REPLACE FUNCTION public.padova_listings_price_drop_candidates(
  p_min_age_days INTEGER DEFAULT 7,
  p_drop_pct     NUMERIC DEFAULT 5
)
RETURNS TABLE(listing_id BIGINT, prezzo_min INTEGER, prezzo_max INTEGER, ribasso_pct NUMERIC, history_days INTEGER)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH agg AS (
    SELECT
      h.listing_id,
      MIN(h.prezzo) AS pmin,
      MAX(h.prezzo) AS pmax,
      (MAX(h.snapshot_date) - MIN(h.snapshot_date))::int AS hdays
    FROM public.padova_listings_price_history h
    JOIN public.padova_listings l ON l.id = h.listing_id
    WHERE l.fonte = 'subito'
    GROUP BY h.listing_id
  )
  SELECT
    a.listing_id,
    a.pmin AS prezzo_min,
    a.pmax AS prezzo_max,
    ROUND( ((a.pmax - a.pmin)::numeric / NULLIF(a.pmax,0)) * 100, 2) AS ribasso_pct,
    a.hdays AS history_days
  FROM agg a
  WHERE a.hdays >= p_min_age_days
    AND a.pmax > 0
    AND ((a.pmax - a.pmin)::numeric / a.pmax) * 100 >= p_drop_pct;
$$;

REVOKE EXECUTE ON FUNCTION public.padova_listings_price_drop_candidates(INTEGER, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.padova_listings_price_drop_candidates(INTEGER, NUMERIC) TO service_role;