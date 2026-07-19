CREATE OR REPLACE VIEW public.padova_listings_zone_v
WITH (security_invoker = true)
AS
WITH tokens AS (
  SELECT
    l.id,
    l.quartiere AS quartiere_raw,
    public.canon_quartiere(btrim(t.tok)) AS chiave
  FROM public.padova_listings l
  LEFT JOIN LATERAL regexp_split_to_table(COALESCE(l.quartiere, ''), '[,/]') AS t(tok)
    ON TRUE
  WHERE l.quartiere IS NULL OR btrim(t.tok) <> ''
),
matched AS (
  SELECT
    tk.id,
    tk.quartiere_raw,
    cm.microzona,
    zm.omi_zone_code,
    zm.zona_slug
  FROM tokens tk
  LEFT JOIN public.quartiere_canon_map cm ON cm.chiave = tk.chiave
  LEFT JOIN public.quartiere_zona_map  zm ON zm.quartiere_key = tk.chiave
)
SELECT
  id,
  MAX(quartiere_raw) AS quartiere_raw,
  COALESCE(ARRAY_AGG(DISTINCT microzona)     FILTER (WHERE microzona     IS NOT NULL), '{}'::text[]) AS microzone,
  COALESCE(ARRAY_AGG(DISTINCT omi_zone_code) FILTER (WHERE omi_zone_code IS NOT NULL), '{}'::text[]) AS omi_codes,
  COALESCE(ARRAY_AGG(DISTINCT zona_slug)     FILTER (WHERE zona_slug     IS NOT NULL), '{}'::text[]) AS zone_slugs
FROM matched
GROUP BY id;

GRANT SELECT ON public.padova_listings_zone_v TO authenticated, service_role;