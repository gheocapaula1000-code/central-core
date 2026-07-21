BEGIN;

CREATE OR REPLACE VIEW public.padova_contendibili_by_zone_v AS
WITH mls_urls AS MATERIALIZED (
  SELECT DISTINCT pl.url
  FROM public.padova_listings pl
  WHERE pl.url IS NOT NULL
    AND public.padova_listing_has_mls_exclusive_evidence(pl.raw_json)
)
SELECT
  pc.*,
  public.civiko_resolve_commercial_zone_slug(pc.quartiere) AS commercial_zone_slug
FROM public.padova_contendibili AS pc
WHERE NOT EXISTS (
  SELECT 1
  FROM unnest(pc.urls) AS u(url)
  WHERE u.url IN (SELECT url FROM mls_urls)
)
AND pc.prezzo_min IS NOT NULL
AND pc.prezzo_max IS NOT NULL
AND pc.prezzo_min > 0
AND pc.prezzo_max > 0
AND ((pc.prezzo_max - pc.prezzo_min)::numeric / pc.prezzo_max) * 100 <= 8;

REVOKE ALL ON public.padova_contendibili_by_zone_v FROM PUBLIC;
REVOKE ALL ON public.padova_contendibili_by_zone_v FROM anon;
REVOKE ALL ON public.padova_contendibili_by_zone_v FROM authenticated;
GRANT SELECT ON public.padova_contendibili_by_zone_v TO service_role;

COMMENT ON VIEW public.padova_contendibili_by_zone_v IS
  'Server-only. Contendibili con commercial_zone_slug via civiko_resolve_commercial_zone_slug(quartiere). Esclude gruppi con almeno una sorgente MLS/esclusiva. Esclude fail-closed gruppi con prezzi nulli/non positivi o price_spread_pct = ((prezzo_max-prezzo_min)/prezzo_max)*100 > 8. Ribassi storici gestiti separatamente. Accesso: service_role.';

COMMIT;