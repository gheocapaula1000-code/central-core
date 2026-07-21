BEGIN;

CREATE INDEX IF NOT EXISTS idx_padova_listings_mls_exclusive_url
  ON public.padova_listings (url)
  WHERE url IS NOT NULL
    AND public.padova_listing_has_mls_exclusive_evidence(raw_json);

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
);

REVOKE ALL ON public.padova_contendibili_by_zone_v FROM PUBLIC;
REVOKE ALL ON public.padova_contendibili_by_zone_v FROM anon;
REVOKE ALL ON public.padova_contendibili_by_zone_v FROM authenticated;
GRANT SELECT ON public.padova_contendibili_by_zone_v TO service_role;

COMMENT ON VIEW public.padova_contendibili_by_zone_v IS
  'Server-only. Contendibili con commercial_zone_slug derivato SOLO da civiko_resolve_commercial_zone_slug(quartiere). Esclude i gruppi in cui almeno una inserzione sorgente presenta evidenza esplicita di incarico in esclusiva o circuito Gruppo Padova MLS. CTE MATERIALIZED + partial index per performance. Accesso: service_role.';

COMMIT;