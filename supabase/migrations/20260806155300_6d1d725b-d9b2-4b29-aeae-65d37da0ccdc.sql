CREATE OR REPLACE VIEW public.civiko_padova_release_gate_v
WITH (security_invoker = true) AS
WITH w AS (SELECT (now() - interval '4 hours') AS since),
portali AS (
  SELECT count(DISTINCT lower(i.portal)) AS portali_freschi
    FROM public.padova_collect_v2_items i, w
   WHERE lower(coalesce(i.citta,'')) = 'padova'
     AND lower(i.portal) IN ('casa','immobiliare','idealista','subito')
     AND (i.created_at >= w.since OR i.updated_at >= w.since)
),
mism AS (SELECT count(*) AS mismatch_professionale FROM public.civiko_padova_tipo_lead_mismatch_v),
promo AS (
  SELECT count(*) AS listings_freschi, max(l.last_seen_at) AS classificazione_ultima
    FROM public.padova_listings l, w
   WHERE l.expired_at IS NULL
     AND lower(coalesce(l.comune,'')) = 'padova'
     AND l.tipo_lead IS NOT NULL
     AND l.last_seen_at >= w.since
),
reco AS (SELECT max(pc.updated_at) AS recompute_ultimo, count(*) AS contendibili_totali
           FROM public.padova_contendibili pc),
perim AS (
  SELECT
    (SELECT count(*) FROM public.padova_contendibili pc
      WHERE pc.commercial_zone_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z
                         WHERE z.slug = pc.commercial_zone_slug)) AS contendibili_fuori_perimetro,
    (SELECT count(*) FROM public.padova_listings l
      WHERE l.expired_at IS NULL
        AND upper(coalesce(l.tipo_lead,'')) IN ('PRIVATO','PRIVATO_STANCO')
        AND lower(coalesce(l.comune,'')) = 'padova'
        AND l.commercial_zone_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z
                         WHERE z.slug = l.commercial_zone_slug)) AS privati_fuori_perimetro
)
SELECT
  portali.portali_freschi,
  mism.mismatch_professionale,
  promo.listings_freschi,
  promo.classificazione_ultima,
  reco.recompute_ultimo,
  reco.contendibili_totali,
  (reco.recompute_ultimo IS NOT NULL AND reco.recompute_ultimo >= (SELECT since FROM w)) AS recompute_corrente,
  (reco.recompute_ultimo IS NOT NULL
   AND promo.classificazione_ultima IS NOT NULL
   AND reco.recompute_ultimo >= promo.classificazione_ultima) AS sync_pwa_dopo_classificazione,
  perim.contendibili_fuori_perimetro,
  perim.privati_fuori_perimetro
FROM portali, mism, promo, reco, perim;

REVOKE ALL ON public.civiko_padova_release_gate_v FROM PUBLIC;
GRANT SELECT ON public.civiko_padova_release_gate_v TO service_role;