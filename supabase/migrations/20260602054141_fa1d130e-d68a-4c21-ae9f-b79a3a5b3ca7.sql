
DROP VIEW IF EXISTS public.omi_microzone_range;
CREATE VIEW public.omi_microzone_range
  WITH (security_invoker = true) AS
SELECT
  lower(comune_descrizione) AS comune_key,
  zona                       AS microzone,
  MIN(compr_min)             AS omi_min,
  MAX(compr_max)             AS omi_max,
  max(semestre)              AS semestre_ultimo
FROM public.omi_valori
WHERE compr_min IS NOT NULL OR compr_max IS NOT NULL
GROUP BY lower(comune_descrizione), zona;

GRANT SELECT ON public.omi_microzone_range TO authenticated, service_role;
