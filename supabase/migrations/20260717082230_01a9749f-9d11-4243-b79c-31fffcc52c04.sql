CREATE OR REPLACE VIEW public.padova_totali_v AS
SELECT
  COUNT(*)::int AS tot_annunci,
  COUNT(DISTINCT agency)::int AS tot_agenzie
FROM public.padova_listings
WHERE agency IS NOT NULL AND btrim(agency) <> '';

GRANT SELECT ON public.padova_totali_v TO authenticated;
GRANT ALL ON public.padova_totali_v TO service_role;
