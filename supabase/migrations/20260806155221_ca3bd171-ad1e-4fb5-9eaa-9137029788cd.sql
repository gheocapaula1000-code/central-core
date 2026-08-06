-- Riallineamento della natura del contatto sugli annunci attivi, con la
-- sola regola ufficiale civiko_classify_tipo_lead (nessuna logica nuova).
CREATE OR REPLACE FUNCTION public.civiko_repair_padova_tipo_lead()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_fixed int := 0;
  v_left int := 0;
BEGIN
  UPDATE public.padova_listings l
     SET tipo_lead = 'AGENZIA'
   WHERE l.expired_at IS NULL
     AND upper(coalesce(l.tipo_lead,'')) IN ('PRIVATO','PRIVATO_STANCO')
     AND public.civiko_classify_tipo_lead(l.tipo_lead, NULL, l.agency) = 'AGENZIA';
  GET DIAGNOSTICS v_fixed = ROW_COUNT;

  SELECT count(*) INTO v_left
    FROM public.padova_listings l
   WHERE l.expired_at IS NULL
     AND upper(coalesce(l.tipo_lead,'')) IN ('PRIVATO','PRIVATO_STANCO')
     AND public.civiko_classify_tipo_lead(l.tipo_lead, NULL, l.agency) = 'AGENZIA';

  IF v_left > 0 THEN
    RAISE EXCEPTION 'tipo_lead mismatch professionale residuo: %', v_left;
  END IF;

  RETURN jsonb_build_object('ok', true, 'updated', v_fixed, 'mismatch_residuo', v_left);
END
$fn$;

REVOKE ALL ON FUNCTION public.civiko_repair_padova_tipo_lead() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.civiko_repair_padova_tipo_lead() TO service_role;

-- Vista di controllo: annunci attivi con classificazione incoerente.
CREATE OR REPLACE VIEW public.civiko_padova_tipo_lead_mismatch_v
WITH (security_invoker = true) AS
SELECT l.id, l.fonte, l.url, l.agency, l.tipo_lead, l.commercial_zone_slug,
       l.last_seen_at
  FROM public.padova_listings l
 WHERE l.expired_at IS NULL
   AND upper(coalesce(l.tipo_lead,'')) IN ('PRIVATO','PRIVATO_STANCO')
   AND public.civiko_classify_tipo_lead(l.tipo_lead, NULL, l.agency) = 'AGENZIA';

REVOKE ALL ON public.civiko_padova_tipo_lead_mismatch_v FROM PUBLIC;
GRANT SELECT ON public.civiko_padova_tipo_lead_mismatch_v TO service_role;

-- Vista di sintesi per il release gate (riga unica, nessun valore stimato).
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
      WHERE pc.commercial_zone_slug IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z
                         WHERE z.slug = pc.commercial_zone_slug)) AS contendibili_fuori_perimetro,
    (SELECT count(*) FROM public.padova_listings l
      WHERE l.expired_at IS NULL
        AND upper(coalesce(l.tipo_lead,'')) IN ('PRIVATO','PRIVATO_STANCO')
        AND (lower(coalesce(l.comune,'')) <> 'padova'
             OR l.commercial_zone_slug IS NULL
             OR NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z
                             WHERE z.slug = l.commercial_zone_slug))) AS privati_fuori_perimetro
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

-- Risanamento immediato della classificazione sugli annunci attivi.
UPDATE public.padova_listings l
   SET tipo_lead = 'AGENZIA'
 WHERE l.expired_at IS NULL
   AND upper(coalesce(l.tipo_lead,'')) IN ('PRIVATO','PRIVATO_STANCO')
   AND public.civiko_classify_tipo_lead(l.tipo_lead, NULL, l.agency) = 'AGENZIA';