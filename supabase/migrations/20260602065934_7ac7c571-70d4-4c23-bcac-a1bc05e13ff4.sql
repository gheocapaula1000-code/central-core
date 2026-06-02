-- Predictive insight column + cross-reference function
ALTER TABLE public.normalized_opportunities
  ADD COLUMN IF NOT EXISTS predictive_insight TEXT;

CREATE OR REPLACE FUNCTION public.generate_predictive_insight(p_opportunity_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o RECORD;
  v_price_per_mq NUMERIC;
  v_omi_mid NUMERIC;
  v_margin_pct NUMERIC;
  v_sent RECORD;
  v_levers TEXT[] := ARRAY[]::TEXT[];
  v_headline TEXT;
  v_insight TEXT;
  v_legal_tag TEXT;
BEGIN
  SELECT * INTO o FROM public.normalized_opportunities WHERE id = p_opportunity_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF o.status = 'bruciato' THEN
    v_insight := 'Immobile bruciato: già presente su portali tradizionali. Nessun vantaggio off-market.';
    UPDATE public.normalized_opportunities SET predictive_insight = v_insight WHERE id = p_opportunity_id;
    RETURN v_insight;
  END IF;

  -- Legal/source tag
  IF 'successione' = ANY(coalesce(o.tags, ARRAY[]::text[])) OR lower(coalesce(o.source_name,'')) LIKE '%successione%' THEN
    v_legal_tag := 'successione';
  ELSIF 'albo_pretorio' = ANY(coalesce(o.tags, ARRAY[]::text[])) OR lower(coalesce(o.source_name,'')) LIKE '%albo%' THEN
    v_legal_tag := 'pratica edilizia / cambio destinazione';
  ELSIF lower(coalesce(o.source_name,'')) LIKE '%pvp%' OR lower(coalesce(o.category,'')) = 'asta' THEN
    v_legal_tag := 'asta giudiziaria';
  ELSIF 'anomalia_omi' = ANY(coalesce(o.tags, ARRAY[]::text[])) THEN
    v_legal_tag := 'anomalia OMI';
  ELSE
    v_legal_tag := 'segnale generico';
  END IF;

  -- Price vs OMI
  IF o.ask_price IS NOT NULL AND o.surface_mq IS NOT NULL AND o.surface_mq > 0
     AND o.valore_omi_min IS NOT NULL AND o.valore_omi_max IS NOT NULL THEN
    v_price_per_mq := o.ask_price / o.surface_mq;
    v_omi_mid := (o.valore_omi_min + o.valore_omi_max) / 2.0;
    IF v_omi_mid > 0 THEN
      v_margin_pct := round(((v_omi_mid - v_price_per_mq) / v_omi_mid) * 100, 1);
    END IF;
  END IF;

  -- Environmental signals (ARPAV/microzone_sentiment)
  IF o.municipality IS NOT NULL THEN
    SELECT noise_score, air_quality_score, safety_proxy_score, urban_decay_risk_score, sentiment_score_total
      INTO v_sent
      FROM public.microzone_sentiment
      WHERE lower(comune) = lower(o.municipality)
        AND (o.microzone IS NULL OR area_label IS NULL OR lower(area_label) = lower(o.microzone))
        AND is_active = true
      ORDER BY confidence_score DESC NULLS LAST
      LIMIT 1;

    IF v_sent.noise_score IS NOT NULL AND v_sent.noise_score < 40 THEN
      v_levers := v_levers || ARRAY['inquinamento acustico alto'];
    END IF;
    IF v_sent.air_quality_score IS NOT NULL AND v_sent.air_quality_score < 40 THEN
      v_levers := v_levers || ARRAY['qualità dell''aria critica'];
    END IF;
    IF v_sent.urban_decay_risk_score IS NOT NULL AND v_sent.urban_decay_risk_score > 60 THEN
      v_levers := v_levers || ARRAY['rischio degrado urbano'];
    END IF;
    IF v_sent.safety_proxy_score IS NOT NULL AND v_sent.safety_proxy_score < 40 THEN
      v_levers := v_levers || ARRAY['percezione sicurezza bassa'];
    END IF;
  END IF;

  -- Headline
  IF v_margin_pct IS NOT NULL AND v_margin_pct > 0 THEN
    v_headline := format('Immobile in %s, margine del %s%% sotto OMI', v_legal_tag, v_margin_pct);
  ELSIF v_margin_pct IS NOT NULL AND v_margin_pct < 0 THEN
    v_headline := format('Immobile in %s, prezzo %s%% sopra OMI (sopravalutato)', v_legal_tag, abs(v_margin_pct));
  ELSE
    v_headline := format('Immobile in %s (valutazione OMI non disponibile)', v_legal_tag);
  END IF;

  IF array_length(v_levers, 1) IS NOT NULL THEN
    v_insight := v_headline || '. Leve negoziali: ' || array_to_string(v_levers, ', ') || '.';
  ELSE
    v_insight := v_headline || '.';
  END IF;

  UPDATE public.normalized_opportunities
     SET predictive_insight = v_insight
   WHERE id = p_opportunity_id;

  RETURN v_insight;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_predictive_insight(UUID) TO service_role;