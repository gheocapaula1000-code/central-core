-- 20260721030000_padova_contendibili_mls_perf.sql
--
-- Purpose: fix HTTP 500 timeout on padova-contendibili-list caused by the
-- MLS/exclusive filter in padova_contendibili_by_zone_v. The filter
-- re-evaluated the IMMUTABLE JSON predicate against every padova_listings
-- row for every candidate group (SubPlan loops), producing 4s+ execution
-- times and connection timeouts for /centro-storico.
--
-- Fix (interface-preserving, additive):
--   1) Partial expression index on padova_listings(url) restricted to rows
--      that satisfy padova_listing_has_mls_exclusive_evidence(raw_json).
--      The predicate function is IMMUTABLE — safe for an expression index.
--      This turns the CTE seq scan into a cheap index-only scan.
--   2) Redefine padova_contendibili_by_zone_v with a MATERIALIZED CTE so
--      the MLS URL set is computed exactly once per query instead of being
--      re-inlined for every candidate row.
--
-- Preserved:
--   • View column list and column order — no interface change.
--   • Zone resolver: still civiko_resolve_commercial_zone_slug(quartiere).
--   • MLS/exclusive exclusion semantics: an entire group is excluded when
--     at least one of its source urls matches an MLS/exclusive listing.
--   • ACL: service_role only. No anon/authenticated/PUBLIC.
--   • No source data mutated. No workspace/zone assignment touched.
--
-- Idempotent: IF NOT EXISTS on the index, CREATE OR REPLACE on the view.

BEGIN;

-- 1) Partial expression index — evaluated once per row at write time.
CREATE INDEX IF NOT EXISTS idx_padova_listings_mls_exclusive_url
  ON public.padova_listings (url)
  WHERE url IS NOT NULL
    AND public.padova_listing_has_mls_exclusive_evidence(raw_json);

-- 2) View: MATERIALIZED CTE to compute mls_urls exactly once per query.
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
