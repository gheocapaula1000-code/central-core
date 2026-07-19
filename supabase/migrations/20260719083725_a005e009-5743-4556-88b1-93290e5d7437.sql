
CREATE OR REPLACE VIEW public.padova_contendibili_reachability_v
WITH (security_invoker = true) AS
WITH cont AS (
  SELECT
    c.id,
    c.quartiere,
    canon_quartiere(c.quartiere) AS chiave,
    c.mq,
    ((COALESCE(c.prezzo_min, c.prezzo_max)::numeric
      + COALESCE(c.prezzo_max, c.prezzo_min)::numeric) / 2.0) AS prezzo_ref
  FROM public.padova_contendibili c
),
cont_mz AS (
  SELECT
    ct.id,
    ct.mq,
    ct.prezzo_ref,
    cm.microzona
  FROM cont ct
  LEFT JOIN public.quartiere_canon_map cm ON cm.chiave = ct.chiave
)
SELECT
  c.id,
  COALESCE(bool_or(m.matched), false) AS reachability_argento,
  COALESCE(count(*) FILTER (WHERE m.matched), 0)::int AS argento_match_count,
  COALESCE(bool_or(m.matched AND m.has_phone), false) AS argento_has_phone,
  (SELECT best.listing_id
   FROM (
     SELECT pl2.id AS listing_id, abs(pl2.prezzo::numeric - cm2.prezzo_ref) AS d
     FROM cont_mz cm2
     JOIN public.padova_listings_zone_v zv ON true
     JOIN public.padova_listings pl2 ON pl2.id = zv.id
     WHERE cm2.id = c.id
       AND pl2.tipo_lead ILIKE 'privato%'
       AND pl2.expired_at IS NULL
       AND pl2.last_seen_at >= (now() - interval '72 hours')
       AND cm2.microzona IS NOT NULL
       AND cm2.microzona = ANY (zv.microzone)
       AND cm2.prezzo_ref IS NOT NULL AND pl2.prezzo IS NOT NULL
       AND pl2.prezzo::numeric BETWEEN cm2.prezzo_ref * 0.9 AND cm2.prezzo_ref * 1.1
       AND cm2.mq IS NOT NULL AND pl2.mq IS NOT NULL
       AND pl2.mq::numeric BETWEEN cm2.mq::numeric * 0.85 AND cm2.mq::numeric * 1.15
     ORDER BY d ASC NULLS LAST
     LIMIT 1
   ) best
  ) AS argento_best_listing_id
FROM public.padova_contendibili c
LEFT JOIN cont_mz cm ON cm.id = c.id
LEFT JOIN LATERAL (
  SELECT
    true AS matched,
    (pl.telefono IS NOT NULL AND btrim(pl.telefono) <> '') AS has_phone
  FROM public.padova_listings_zone_v zv
  JOIN public.padova_listings pl ON pl.id = zv.id
  WHERE pl.tipo_lead ILIKE 'privato%'
    AND pl.expired_at IS NULL
    AND pl.last_seen_at >= (now() - interval '72 hours')
    AND cm.microzona IS NOT NULL
    AND cm.microzona = ANY (zv.microzone)
    AND cm.prezzo_ref IS NOT NULL AND pl.prezzo IS NOT NULL
    AND pl.prezzo::numeric BETWEEN cm.prezzo_ref * 0.9 AND cm.prezzo_ref * 1.1
    AND cm.mq IS NOT NULL AND pl.mq IS NOT NULL
    AND pl.mq::numeric BETWEEN cm.mq::numeric * 0.85 AND cm.mq::numeric * 1.15
) m ON true
GROUP BY c.id;

REVOKE ALL ON public.padova_contendibili_reachability_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.padova_contendibili_reachability_v TO service_role;
