-- 20260721020000_padova_contendibili_exclude_mls.sql
BEGIN;

CREATE OR REPLACE FUNCTION public.padova_listing_has_mls_exclusive_evidence(
  p_raw jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public'
AS $$
  SELECT
    (
      lower(
        coalesce(p_raw->>'title','')                        || ' ' ||
        coalesce(p_raw->'suggestedTexts'->>'title','')      || ' ' ||
        coalesce(p_raw->>'subject','')                      || ' ' ||
        coalesce(p_raw->>'description','')                  || ' ' ||
        coalesce(p_raw->>'notes','')
      ) ~ '(in esclusiva|incarico in esclusiva|esclusiva al gruppo padova mls|gruppo padova mls|padova mls)'
    )
    OR coalesce(p_raw->>'externalReference','') ~* '(^|[^a-z])mls[-_ ]?[0-9]'
    OR coalesce(p_raw->>'reference','')         ~* '(^|[^a-z])mls[-_ ]?[0-9]'
    OR coalesce(p_raw->>'code','')              ~* '(^|[^a-z])mls[-_ ]?[0-9]'
    OR coalesce(p_raw->>'listing_code','')      ~* '(^|[^a-z])mls[-_ ]?[0-9]'
$$;

REVOKE ALL ON FUNCTION public.padova_listing_has_mls_exclusive_evidence(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.padova_listing_has_mls_exclusive_evidence(jsonb) TO service_role;

COMMENT ON FUNCTION public.padova_listing_has_mls_exclusive_evidence(jsonb) IS
  'True se il raw_json della inserzione presenta evidenza esplicita di incarico in esclusiva o appartenenza al circuito Gruppo Padova MLS.';

CREATE OR REPLACE VIEW public.padova_contendibili_by_zone_v AS
WITH mls_urls AS (
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
  'Server-only. Contendibili con commercial_zone_slug derivato SOLO da civiko_resolve_commercial_zone_slug(quartiere). Esclude i gruppi in cui almeno una inserzione sorgente presenta evidenza esplicita di incarico in esclusiva o circuito Gruppo Padova MLS. Accesso: service_role.';

COMMIT;