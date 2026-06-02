
-- 1) Estensione schema
ALTER TABLE public.normalized_opportunities
  ADD COLUMN IF NOT EXISTS cap TEXT,
  ADD COLUMN IF NOT EXISTS valore_omi_min NUMERIC,
  ADD COLUMN IF NOT EXISTS valore_omi_max NUMERIC,
  ADD COLUMN IF NOT EXISTS data_rilevamento TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS quality_bucket TEXT,
  ADD COLUMN IF NOT EXISTS priority TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT;

CREATE INDEX IF NOT EXISTS idx_norm_opp_quality_bucket
  ON public.normalized_opportunities(quality_bucket);
CREATE INDEX IF NOT EXISTS idx_norm_opp_priority
  ON public.normalized_opportunities(priority);
CREATE INDEX IF NOT EXISTS idx_norm_opp_status
  ON public.normalized_opportunities(status);
CREATE INDEX IF NOT EXISTS idx_norm_opp_cap
  ON public.normalized_opportunities(cap);

-- 2) Vista helper: range OMI per comune + microzona (zona)
CREATE OR REPLACE VIEW public.omi_microzone_range AS
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

-- 3) Funzione di classificazione
CREATE OR REPLACE FUNCTION public.classify_opportunity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_omi_max NUMERIC;
  v_omi_min NUMERIC;
  v_price_per_mq NUMERIC;
  v_source_lc TEXT := lower(coalesce(NEW.source_name, ''));
  v_category_lc TEXT := lower(coalesce(NEW.category, ''));
  v_title_lc TEXT := lower(coalesce(NEW.title, ''));
  v_is_asta BOOLEAN;
  v_is_successione BOOLEAN;
  v_is_anomalia_omi BOOLEAN;
  v_age_hours NUMERIC;
BEGIN
  -- data_rilevamento default
  IF NEW.data_rilevamento IS NULL THEN
    NEW.data_rilevamento := now();
  END IF;

  v_is_asta := v_source_lc LIKE '%pvp%'
            OR v_source_lc LIKE '%portale vendite pubbliche%'
            OR v_category_lc = 'asta'
            OR v_title_lc LIKE 'asta %';

  v_is_successione := v_source_lc LIKE '%successione%'
                   OR v_category_lc LIKE '%succession%'
                   OR 'successione' = ANY(coalesce(NEW.tags, ARRAY[]::text[]));

  v_is_anomalia_omi := v_source_lc LIKE '%anomalia omi%'
                    OR v_category_lc LIKE '%anomalia_omi%'
                    OR 'anomalia_omi' = ANY(coalesce(NEW.tags, ARRAY[]::text[]));

  v_age_hours := EXTRACT(EPOCH FROM (now() - NEW.data_rilevamento)) / 3600.0;

  -- Lookup OMI per la microzona (best effort)
  IF NEW.municipality IS NOT NULL AND NEW.microzone IS NOT NULL THEN
    SELECT omi_min, omi_max
      INTO v_omi_min, v_omi_max
      FROM public.omi_microzone_range
      WHERE comune_key = lower(NEW.municipality)
        AND microzone = NEW.microzone
      LIMIT 1;

    IF v_omi_min IS NOT NULL AND NEW.valore_omi_min IS NULL THEN
      NEW.valore_omi_min := v_omi_min;
    END IF;
    IF v_omi_max IS NOT NULL AND NEW.valore_omi_max IS NULL THEN
      NEW.valore_omi_max := v_omi_max;
    END IF;
  END IF;

  -- Regola 1 — Aste sotto soglia → rumore di fondo
  IF v_is_asta AND NEW.ask_price IS NOT NULL AND NEW.ask_price < 50000 THEN
    NEW.quality_bucket := 'rumore_di_fondo';
    NEW.priority := 'bassa';
    NEW.status := COALESCE(NEW.status, 'archiviato');
    NEW.scoring_reason := COALESCE(NEW.scoring_reason, '') ||
      ' [R1] Asta PVP < 50k€ classificata come rumore di fondo.';
    RETURN NEW;
  END IF;

  -- Regola 2 — Off-market caldo (≤24h)
  IF (v_is_successione OR v_is_anomalia_omi) AND v_age_hours <= 24 THEN
    NEW.quality_bucket := 'alta_priorita';
    NEW.priority := 'alta';
    NEW.status := COALESCE(NEW.status, 'da_aggredire');
    NEW.tags := array(SELECT DISTINCT unnest(coalesce(NEW.tags, ARRAY[]::text[]) || ARRAY['Nuovo Segnale']));
    NEW.scoring_reason := COALESCE(NEW.scoring_reason, '') ||
      ' [R2] Off-market caldo (<=24h): successione/anomalia OMI.';
    RETURN NEW;
  END IF;

  -- Regola 3 — Dossier pronto: prezzo > 115% OMI max della zona
  IF NEW.ask_price IS NOT NULL
     AND NEW.surface_mq IS NOT NULL AND NEW.surface_mq > 0
     AND NEW.valore_omi_max IS NOT NULL AND NEW.valore_omi_max > 0 THEN
    v_price_per_mq := NEW.ask_price / NEW.surface_mq;
    IF v_price_per_mq > NEW.valore_omi_max * 1.15 THEN
      NEW.quality_bucket := 'dossier_pronto';
      NEW.priority := 'alta';
      NEW.status := COALESCE(NEW.status, 'da_aggredire');
      NEW.scoring_reason := COALESCE(NEW.scoring_reason, '') ||
        format(' [R3] Prezzo %.0f €/mq > 115%% OMI max %.0f €/mq.', v_price_per_mq, NEW.valore_omi_max);
      RETURN NEW;
    END IF;
  END IF;

  -- Default qualificato
  IF NEW.quality_bucket IS NULL THEN NEW.quality_bucket := 'qualificato'; END IF;
  IF NEW.priority IS NULL       THEN NEW.priority := 'media';       END IF;
  IF NEW.status IS NULL         THEN NEW.status := 'da_valutare';   END IF;

  RETURN NEW;
END;
$$;

-- 4) Trigger BEFORE INSERT OR UPDATE
DROP TRIGGER IF EXISTS classify_opportunity_trigger ON public.normalized_opportunities;
CREATE TRIGGER classify_opportunity_trigger
  BEFORE INSERT OR UPDATE OF ask_price, surface_mq, source_name, category, tags, microzone, municipality, data_rilevamento
  ON public.normalized_opportunities
  FOR EACH ROW
  EXECUTE FUNCTION public.classify_opportunity();

COMMENT ON FUNCTION public.classify_opportunity() IS
  'Scoring engine: assegna quality_bucket / priority / status alle opportunità in base a regole reali (Aste PVP <50k, Off-market caldo <=24h, Dossier pronto >115% OMI max).';
