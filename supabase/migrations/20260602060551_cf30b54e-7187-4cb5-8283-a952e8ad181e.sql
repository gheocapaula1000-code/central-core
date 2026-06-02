
-- ════════════════════════════════════════════════════════════════
-- MASTER ARCHITECTURE: True Off-Market Engine
-- 1) check_if_marketed(): anti-portal filter
-- 2) classify_opportunity v2: applies anti-portal + institutional boost
-- ════════════════════════════════════════════════════════════════

-- Tag column for institutional sources is already covered via tags/source_name.
-- Add an index on normalized address for fast match (idempotent).
CREATE INDEX IF NOT EXISTS idx_norm_opp_addr_lower
  ON public.normalized_opportunities (lower(coalesce(address_text,'')));
CREATE INDEX IF NOT EXISTS idx_norm_opp_cap
  ON public.normalized_opportunities (cap);
CREATE INDEX IF NOT EXISTS idx_norm_opp_muni_surface
  ON public.normalized_opportunities (lower(coalesce(municipality,'')), surface_mq);

-- ────────────────────────────────────────────────────────────────
-- check_if_marketed: returns TRUE if a matching listing already
-- exists from a *portal* source (Immobiliare, Idealista, Casa.it,
-- Subito, Wikicasa, ecc.) for the same address OR same
-- (municipality + microzone + surface ±5 mq).
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_if_marketed(
  p_address    TEXT,
  p_cap        TEXT,
  p_municipality TEXT DEFAULT NULL,
  p_microzone  TEXT DEFAULT NULL,
  p_surface_mq NUMERIC DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_addr_norm TEXT := lower(regexp_replace(coalesce(p_address,''), '[^a-z0-9 ]', ' ', 'g'));
  v_match BOOLEAN := false;
  v_portal_filter TEXT :=
    '%immobiliare%|%idealista%|%casa.it%|%subito%|%wikicasa%|%bakeca%|%trovacasa%|%gate-away%|%homegate%|%remax%|%tecnocasa%|%gabetti%|%engelvoelkers%|%agenzia%';
BEGIN
  IF v_addr_norm IS NOT NULL AND length(v_addr_norm) > 6 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.normalized_opportunities o
      WHERE (
              lower(coalesce(o.source_name,'')) ~ '(immobiliare|idealista|casa\.it|subito|wikicasa|bakeca|trovacasa|gate-away|homegate|remax|tecnocasa|gabetti|engel|agenzia|portale)'
           OR lower(coalesce(o.source_url,''))  ~ '(immobiliare|idealista|casa\.it|subito|wikicasa|bakeca|trovacasa|gate-away|homegate|remax|tecnocasa|gabetti|engel)'
            )
        AND lower(regexp_replace(coalesce(o.address_text,''), '[^a-z0-9 ]', ' ', 'g')) LIKE '%' || v_addr_norm || '%'
        AND (p_cap IS NULL OR o.cap IS NULL OR o.cap = p_cap)
    ) INTO v_match;
    IF v_match THEN RETURN TRUE; END IF;
  END IF;

  IF p_municipality IS NOT NULL AND p_microzone IS NOT NULL AND p_surface_mq IS NOT NULL AND p_surface_mq > 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.normalized_opportunities o
      WHERE lower(coalesce(o.source_name,'')) ~ '(immobiliare|idealista|casa\.it|subito|wikicasa|bakeca|trovacasa|remax|tecnocasa|gabetti|engel|agenzia|portale)'
        AND lower(coalesce(o.municipality,'')) = lower(p_municipality)
        AND lower(coalesce(o.microzone,''))    = lower(p_microzone)
        AND o.surface_mq IS NOT NULL
        AND abs(o.surface_mq - p_surface_mq) <= 5
    ) INTO v_match;
  END IF;

  RETURN coalesce(v_match, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_if_marketed(TEXT,TEXT,TEXT,TEXT,NUMERIC) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- classify_opportunity v2 — adds anti-portal filter and
-- off-market_puro classification for institutional sources.
-- Keeps R1/R2/R3 from previous version.
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.classify_opportunity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_omi_max NUMERIC;
  v_omi_min NUMERIC;
  v_price_per_mq NUMERIC;
  v_source_lc TEXT := lower(coalesce(NEW.source_name, ''));
  v_url_lc    TEXT := lower(coalesce(NEW.source_url, ''));
  v_category_lc TEXT := lower(coalesce(NEW.category, ''));
  v_title_lc TEXT := lower(coalesce(NEW.title, ''));
  v_is_asta BOOLEAN;
  v_is_successione BOOLEAN;
  v_is_anomalia_omi BOOLEAN;
  v_is_albo_pretorio BOOLEAN;
  v_is_tribunale BOOLEAN;
  v_is_institutional BOOLEAN;
  v_is_marketed BOOLEAN;
  v_age_hours NUMERIC;
BEGIN
  IF NEW.data_rilevamento IS NULL THEN
    NEW.data_rilevamento := now();
  END IF;

  v_is_asta := v_source_lc LIKE '%pvp%'
            OR v_source_lc LIKE '%portale vendite pubbliche%'
            OR v_source_lc LIKE '%aste_nascoste%'
            OR v_category_lc = 'asta'
            OR v_title_lc LIKE 'asta %';

  v_is_successione := v_source_lc LIKE '%successione%'
                   OR v_category_lc LIKE '%succession%'
                   OR 'successione' = ANY(coalesce(NEW.tags, ARRAY[]::text[]));

  v_is_anomalia_omi := v_source_lc LIKE '%anomalia omi%'
                    OR v_category_lc LIKE '%anomalia_omi%'
                    OR 'anomalia_omi' = ANY(coalesce(NEW.tags, ARRAY[]::text[]));

  v_is_albo_pretorio := v_source_lc LIKE '%albo%pretorio%'
                     OR v_source_lc LIKE '%albo_pretorio%'
                     OR 'albo_pretorio' = ANY(coalesce(NEW.tags, ARRAY[]::text[]));

  v_is_tribunale := v_source_lc LIKE '%tribunale%'
                 OR v_source_lc LIKE '%giustizia%'
                 OR v_is_asta;

  v_is_institutional := v_is_albo_pretorio
                     OR v_is_successione
                     OR v_is_tribunale
                     OR v_is_anomalia_omi;

  v_age_hours := EXTRACT(EPOCH FROM (now() - NEW.data_rilevamento)) / 3600.0;

  -- OMI lookup
  IF NEW.municipality IS NOT NULL AND NEW.microzone IS NOT NULL THEN
    SELECT omi_min, omi_max
      INTO v_omi_min, v_omi_max
      FROM public.omi_microzone_range
      WHERE comune_key = lower(NEW.municipality)
        AND microzone = NEW.microzone
      LIMIT 1;
    IF v_omi_min IS NOT NULL AND NEW.valore_omi_min IS NULL THEN NEW.valore_omi_min := v_omi_min; END IF;
    IF v_omi_max IS NOT NULL AND NEW.valore_omi_max IS NULL THEN NEW.valore_omi_max := v_omi_max; END IF;
  END IF;

  -- ──────────────────────────────────────────────
  -- FILTRO ANTI-PORTALE — solo per fonti istituzionali
  -- (per le altre, il fatto di essere su un portale è normale)
  -- ──────────────────────────────────────────────
  IF v_is_institutional THEN
    v_is_marketed := public.check_if_marketed(
      NEW.address_text,
      NEW.cap,
      NEW.municipality,
      NEW.microzone,
      NEW.surface_mq
    );

    IF v_is_marketed THEN
      NEW.status := 'bruciato';
      NEW.quality_bucket := 'scarto';
      NEW.priority := 'bassa';
      NEW.tags := array(SELECT DISTINCT unnest(coalesce(NEW.tags, ARRAY[]::text[]) || ARRAY['bruciato','anti_portale']));
      NEW.scoring_reason := COALESCE(NEW.scoring_reason, '') ||
        ' [ANTI-PORTALE] Record già a mercato su portale tradizionale.';
      RETURN NEW;
    END IF;
  END IF;

  -- R1 — aste sotto soglia
  IF v_is_asta AND NEW.ask_price IS NOT NULL AND NEW.ask_price < 50000 THEN
    NEW.quality_bucket := 'rumore_di_fondo';
    NEW.priority := 'bassa';
    NEW.status := COALESCE(NEW.status, 'archiviato');
    NEW.scoring_reason := COALESCE(NEW.scoring_reason, '') ||
      ' [R1] Asta PVP < 50k€ classificata come rumore di fondo.';
    RETURN NEW;
  END IF;

  -- ──────────────────────────────────────────────
  -- OFF-MARKET PURO — istituzionale + non a mercato
  -- ──────────────────────────────────────────────
  IF v_is_institutional THEN
    NEW.status := 'off-market_puro';
    NEW.quality_bucket := 'alta_priorita';
    NEW.priority := 'alta';
    NEW.tags := array(SELECT DISTINCT unnest(coalesce(NEW.tags, ARRAY[]::text[]) || ARRAY['off_market_puro','Nuovo Segnale']));
    NEW.scoring_reason := COALESCE(NEW.scoring_reason, '') ||
      ' [OFF-MARKET PURO] Fonte istituzionale, non presente su portali.';
    RETURN NEW;
  END IF;

  -- R2 — off-market caldo ≤24h (legacy)
  IF (v_is_successione OR v_is_anomalia_omi) AND v_age_hours <= 24 THEN
    NEW.quality_bucket := 'alta_priorita';
    NEW.priority := 'alta';
    NEW.status := COALESCE(NEW.status, 'da_aggredire');
    NEW.tags := array(SELECT DISTINCT unnest(coalesce(NEW.tags, ARRAY[]::text[]) || ARRAY['Nuovo Segnale']));
    NEW.scoring_reason := COALESCE(NEW.scoring_reason, '') ||
      ' [R2] Off-market caldo (<=24h).';
    RETURN NEW;
  END IF;

  -- R3 — dossier pronto: prezzo > 115% OMI max
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

  -- default
  IF NEW.quality_bucket IS NULL THEN NEW.quality_bucket := 'qualificato'; END IF;
  IF NEW.priority IS NULL       THEN NEW.priority := 'media';            END IF;
  IF NEW.status IS NULL         THEN NEW.status := 'da_valutare';         END IF;

  RETURN NEW;
END;
$$;

-- Ensure trigger is attached (idempotent)
DROP TRIGGER IF EXISTS trg_classify_opportunity ON public.normalized_opportunities;
CREATE TRIGGER trg_classify_opportunity
  BEFORE INSERT OR UPDATE ON public.normalized_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.classify_opportunity();
