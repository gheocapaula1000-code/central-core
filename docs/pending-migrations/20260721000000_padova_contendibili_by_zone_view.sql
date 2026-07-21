-- Pending migration — DO NOT APPLY without review.
--
-- Purpose:
--   Provide a server-only, filterable view of public.padova_contendibili that
--   exposes commercial_zone_slug computed exclusively via the canonical
--   resolver public.civiko_resolve_commercial_zone_slug(quartiere).
--
--   Central Core's padova-contendibili-list must never fetch rows across all
--   zones and filter in memory: this view lets the edge function apply the
--   zone filter INSIDE the database, before pagination / count / hot_3plus.
--
-- Contract:
--   • No source data is modified. This is a pure SELECT view.
--   • 1:1 with padova_contendibili (no join fan-out). Rows whose quartiere is
--     null or unknown to the resolver receive commercial_zone_slug = NULL and
--     are therefore invisible to any strict .eq(...) zone filter (fail-closed).
--   • Access is restricted to service_role. Revoked for PUBLIC/anon/authenticated
--     so no PostgREST client can reach it.
--
-- Rationale:
--   padova_contendibili has no commercial_zone_slug column and
--   padova_listings_zone_v / padova_contendibili_reachability_v do not carry
--   the official 8-zone contract slug. A dedicated server-only view is the
--   minimal, additive way to keep the writer-side quartiere-only contract
--   authoritative at read time as well.

CREATE OR REPLACE VIEW public.padova_contendibili_by_zone_v AS
SELECT
  pc.*,
  public.civiko_resolve_commercial_zone_slug(pc.quartiere) AS commercial_zone_slug
FROM public.padova_contendibili AS pc;

REVOKE ALL ON public.padova_contendibili_by_zone_v FROM PUBLIC;
REVOKE ALL ON public.padova_contendibili_by_zone_v FROM anon;
REVOKE ALL ON public.padova_contendibili_by_zone_v FROM authenticated;
GRANT SELECT ON public.padova_contendibili_by_zone_v TO service_role;

COMMENT ON VIEW public.padova_contendibili_by_zone_v IS
  'Server-only. Contendibili con commercial_zone_slug derivato SOLO da civiko_resolve_commercial_zone_slug(quartiere). Accesso: service_role.';
