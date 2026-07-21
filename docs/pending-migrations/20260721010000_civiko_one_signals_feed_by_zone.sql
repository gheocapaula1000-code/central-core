-- Pending migration — DO NOT APPLY without review.
--
-- Purpose:
--   Enable DB-level commercial-zone isolation for every source consumed by
--   supabase/functions/civiko-one-signals-feed. Each addition is server-only
--   (service_role) and derives commercial_zone_slug ONLY via the canonical
--   resolver public.civiko_resolve_commercial_zone_slug(quartiere).
--
-- Additions (all additive; no source data modified):
--   1. public.padova_multi_portale_by_zone_v
--   2. public.padova_collect_v2_items_by_zone_v
--   3. public.get_padova_verified_price_drops_by_zone(...)  — mandatory p_commercial_zone_slug
--
-- Fail-closed contract:
--   Rows whose quartiere is null or unknown to the resolver receive
--   commercial_zone_slug = NULL and are invisible to any strict .eq(...) filter.
--   Access is revoked from PUBLIC/anon/authenticated → no PostgREST client can
--   reach the objects.

-- ─── 1. Multi-portale zone-scoped view ─────────────────────────────────
CREATE OR REPLACE VIEW public.padova_multi_portale_by_zone_v AS
SELECT
  mp.*,
  public.civiko_resolve_commercial_zone_slug(mp.quartiere) AS commercial_zone_slug
FROM public.padova_multi_portale AS mp;

REVOKE ALL ON public.padova_multi_portale_by_zone_v FROM PUBLIC;
REVOKE ALL ON public.padova_multi_portale_by_zone_v FROM anon;
REVOKE ALL ON public.padova_multi_portale_by_zone_v FROM authenticated;
GRANT SELECT ON public.padova_multi_portale_by_zone_v TO service_role;

COMMENT ON VIEW public.padova_multi_portale_by_zone_v IS
  'Server-only. Multi-portale con commercial_zone_slug derivato SOLO da civiko_resolve_commercial_zone_slug(quartiere). Accesso: service_role.';

-- ─── 2. Collect v2 items (privati + ribassi fallback) zone-scoped view ─
CREATE OR REPLACE VIEW public.padova_collect_v2_items_by_zone_v AS
SELECT
  ci.*,
  public.civiko_resolve_commercial_zone_slug(ci.quartiere) AS commercial_zone_slug
FROM public.padova_collect_v2_items AS ci;

REVOKE ALL ON public.padova_collect_v2_items_by_zone_v FROM PUBLIC;
REVOKE ALL ON public.padova_collect_v2_items_by_zone_v FROM anon;
REVOKE ALL ON public.padova_collect_v2_items_by_zone_v FROM authenticated;
GRANT SELECT ON public.padova_collect_v2_items_by_zone_v TO service_role;

COMMENT ON VIEW public.padova_collect_v2_items_by_zone_v IS
  'Server-only. Collect v2 items con commercial_zone_slug derivato SOLO da civiko_resolve_commercial_zone_slug(quartiere). Accesso: service_role.';

-- ─── 3. RPC ribassi con parametro zona OBBLIGATORIO ────────────────────
CREATE OR REPLACE FUNCTION public.get_padova_verified_price_drops_by_zone(
  p_commercial_zone_slug text,
  p_limit integer DEFAULT 500,
  p_min_drop_pct numeric DEFAULT 5,
  p_max_age_days integer DEFAULT 14
)
RETURNS TABLE (
  source_id text, listing_id text, source text, url text, title text, mq numeric,
  lat double precision, lng double precision,
  initial_price_eur numeric, current_price_eur numeric, total_drop_pct numeric,
  drops_count integer, observations_count integer,
  first_seen_at timestamptz, last_seen_at timestamptz,
  comune text, omi_zone text, commercial_zone_slug text,
  zone_match_method text, zone_match_confidence numeric,
  raw_title text, raw_address text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Wrapper fail-closed: la zona è obbligatoria e filtrata dentro il DB.
  -- Se il chiamante passa uno slug non riconosciuto o NULL, ritorna 0 righe.
  SELECT *
  FROM public.get_padova_verified_price_drops(p_limit, p_min_drop_pct, p_max_age_days) AS d
  WHERE p_commercial_zone_slug IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.civiko_commercial_zones z
      WHERE z.slug = p_commercial_zone_slug
    )
    AND d.commercial_zone_slug = p_commercial_zone_slug;
$$;

REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops_by_zone(text, integer, numeric, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops_by_zone(text, integer, numeric, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops_by_zone(text, integer, numeric, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_padova_verified_price_drops_by_zone(text, integer, numeric, integer) TO service_role;

COMMENT ON FUNCTION public.get_padova_verified_price_drops_by_zone(text, integer, numeric, integer) IS
  'Server-only wrapper di get_padova_verified_price_drops con filtro OBBLIGATORIO su commercial_zone_slug. Accesso: service_role.';
