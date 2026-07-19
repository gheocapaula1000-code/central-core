
CREATE OR REPLACE VIEW public.padova_contendibili_reachability_v
WITH (security_invoker = true) AS
WITH cont AS (
  SELECT
    c.id,
    canon_quartiere(c.quartiere) AS chiave,
    c.mq,
    ((COALESCE(c.prezzo_min, c.prezzo_max)::numeric
      + COALESCE(c.prezzo_max, c.prezzo_min)::numeric) / 2.0) AS prezzo_ref
  FROM public.padova_contendibili c
),
cont_mz AS (
  SELECT ct.id, ct.mq, ct.prezzo_ref, cm.microzona
  FROM cont ct
  LEFT JOIN public.quartiere_canon_map cm ON cm.chiave = ct.chiave
),
priv AS (
  SELECT pl.id, pl.prezzo, pl.mq, pl.telefono, zv.microzone
  FROM public.padova_listings pl
  JOIN public.padova_listings_zone_v zv ON zv.id = pl.id
  WHERE pl.tipo_lead ILIKE 'privato%'
    AND pl.expired_at IS NULL
    AND pl.last_seen_at >= (now() - interval '72 hours')
    AND pl.prezzo IS NOT NULL
    AND pl.mq IS NOT NULL
),
matches AS (
  SELECT
    cm.id AS cont_id,
    pr.id AS listing_id,
    (pr.telefono IS NOT NULL AND btrim(pr.telefono) <> '') AS has_phone,
    abs(pr.prezzo::numeric - cm.prezzo_ref) AS delta
  FROM cont_mz cm
  JOIN priv pr
    ON cm.microzona IS NOT NULL
   AND cm.microzona = ANY (pr.microzone)
   AND cm.prezzo_ref IS NOT NULL
   AND pr.prezzo::numeric BETWEEN cm.prezzo_ref * 0.9 AND cm.prezzo_ref * 1.1
   AND cm.mq IS NOT NULL
   AND pr.mq::numeric BETWEEN cm.mq::numeric * 0.85 AND cm.mq::numeric * 1.15
),
agg AS (
  SELECT
    cont_id,
    count(*)::int AS argento_match_count,
    bool_or(has_phone) AS argento_has_phone,
    (array_agg(listing_id ORDER BY delta ASC NULLS LAST))[1] AS argento_best_listing_id
  FROM matches
  GROUP BY cont_id
)
SELECT
  c.id,
  (a.argento_match_count IS NOT NULL AND a.argento_match_count > 0) AS reachability_argento,
  COALESCE(a.argento_match_count, 0) AS argento_match_count,
  COALESCE(a.argento_has_phone, false) AS argento_has_phone,
  a.argento_best_listing_id
FROM public.padova_contendibili c
LEFT JOIN agg a ON a.cont_id = c.id;

REVOKE ALL ON public.padova_contendibili_reachability_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.padova_contendibili_reachability_v TO service_role;
