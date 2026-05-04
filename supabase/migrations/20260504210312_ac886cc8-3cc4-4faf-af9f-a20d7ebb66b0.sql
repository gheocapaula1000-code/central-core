
-- 1. legal_property_signals
CREATE TABLE IF NOT EXISTS public.legal_property_signals (
  id BIGSERIAL PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_url TEXT,
  source_document_id BIGINT,
  signal_type TEXT NOT NULL,
  comune TEXT,
  provincia TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  area_label TEXT,
  property_type TEXT,
  estimated_asset_type TEXT,
  court_or_authority TEXT,
  procedure_date DATE,
  sale_date DATE,
  base_price_eur NUMERIC,
  minimum_bid_eur NUMERIC,
  status TEXT,
  confidence_score NUMERIC NOT NULL DEFAULT 0,
  quality TEXT NOT NULL DEFAULT 'parziale',
  data_basis TEXT[] NOT NULL DEFAULT '{}',
  extracted_entities JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  privacy_redacted BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fingerprint TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_lps_comune ON public.legal_property_signals(comune);
CREATE INDEX IF NOT EXISTS idx_lps_provincia ON public.legal_property_signals(provincia);
CREATE INDEX IF NOT EXISTS idx_lps_signal_type ON public.legal_property_signals(signal_type);
CREATE INDEX IF NOT EXISTS idx_lps_sale_date ON public.legal_property_signals(sale_date);
ALTER TABLE public.legal_property_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_legal_property_signals" ON public.legal_property_signals FOR SELECT USING (true);
CREATE POLICY "service_role_full_legal_property_signals" ON public.legal_property_signals FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. listing_velocity_signals
CREATE TABLE IF NOT EXISTS public.listing_velocity_signals (
  id BIGSERIAL PRIMARY KEY,
  listing_hash TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT,
  comune TEXT,
  provincia TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  property_type TEXT,
  price_eur NUMERIC,
  previous_price_eur NUMERIC,
  surface_mq NUMERIC,
  price_per_mq NUMERIC,
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hours_since_first_seen NUMERIC,
  days_online INTEGER,
  price_drop_percent NUMERIC,
  repost_detected BOOLEAN NOT NULL DEFAULT false,
  stale_listing BOOLEAN NOT NULL DEFAULT false,
  fresh_listing BOOLEAN NOT NULL DEFAULT false,
  velocity_type TEXT NOT NULL DEFAULT 'unknown',
  confidence_score NUMERIC NOT NULL DEFAULT 0,
  quality TEXT NOT NULL DEFAULT 'parziale',
  data_basis TEXT[] NOT NULL DEFAULT '{}',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_hash, velocity_type)
);
CREATE INDEX IF NOT EXISTS idx_lvs_velocity_type ON public.listing_velocity_signals(velocity_type);
CREATE INDEX IF NOT EXISTS idx_lvs_comune ON public.listing_velocity_signals(comune);
CREATE INDEX IF NOT EXISTS idx_lvs_detected_at ON public.listing_velocity_signals(detected_at DESC);
ALTER TABLE public.listing_velocity_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_lvs" ON public.listing_velocity_signals FOR SELECT USING (true);
CREATE POLICY "service_role_full_lvs" ON public.listing_velocity_signals FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. pricing_error_signals
CREATE TABLE IF NOT EXISTS public.pricing_error_signals (
  id BIGSERIAL PRIMARY KEY,
  listing_hash TEXT NOT NULL,
  source_name TEXT,
  source_url TEXT,
  comune TEXT,
  provincia TEXT,
  property_type TEXT,
  price_eur NUMERIC,
  surface_mq NUMERIC,
  price_per_mq NUMERIC,
  omi_min NUMERIC,
  omi_max NUMERIC,
  omi_avg NUMERIC,
  comparable_avg NUMERIC,
  deviation_from_omi_percent NUMERIC,
  deviation_from_comparable_percent NUMERIC,
  pricing_error_type TEXT NOT NULL DEFAULT 'unknown',
  score NUMERIC NOT NULL DEFAULT 0,
  confidence_score NUMERIC NOT NULL DEFAULT 0,
  reason TEXT,
  recommended_action TEXT,
  quality TEXT NOT NULL DEFAULT 'parziale',
  data_basis TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_hash, pricing_error_type)
);
CREATE INDEX IF NOT EXISTS idx_pes_comune ON public.pricing_error_signals(comune);
CREATE INDEX IF NOT EXISTS idx_pes_error_type ON public.pricing_error_signals(pricing_error_type);
ALTER TABLE public.pricing_error_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_pes" ON public.pricing_error_signals FOR SELECT USING (true);
CREATE POLICY "service_role_full_pes" ON public.pricing_error_signals FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. urgent_opportunity_signals
CREATE TABLE IF NOT EXISTS public.urgent_opportunity_signals (
  id BIGSERIAL PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  comune TEXT,
  provincia TEXT,
  area_label TEXT,
  opportunity_type TEXT NOT NULL,
  priority TEXT NOT NULL,
  time_window TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT,
  agent_action TEXT,
  script TEXT,
  target TEXT,
  source_urls TEXT[] NOT NULL DEFAULT '{}',
  data_basis TEXT[] NOT NULL DEFAULT '{}',
  confidence_score NUMERIC NOT NULL DEFAULT 0,
  quality TEXT NOT NULL DEFAULT 'parziale',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_uos_priority ON public.urgent_opportunity_signals(priority);
CREATE INDEX IF NOT EXISTS idx_uos_comune ON public.urgent_opportunity_signals(comune);
CREATE INDEX IF NOT EXISTS idx_uos_expires_at ON public.urgent_opportunity_signals(expires_at);
ALTER TABLE public.urgent_opportunity_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_uos" ON public.urgent_opportunity_signals FOR SELECT USING (true);
CREATE POLICY "service_role_full_uos" ON public.urgent_opportunity_signals FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. crawl_watchlist
CREATE TABLE IF NOT EXISTS public.crawl_watchlist (
  id BIGSERIAL PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_type TEXT NOT NULL,
  province TEXT[] NOT NULL DEFAULT '{}',
  comuni TEXT[] NOT NULL DEFAULT '{}',
  watch_frequency TEXT NOT NULL DEFAULT 'daily',
  last_crawled_at TIMESTAMPTZ,
  next_crawl_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ready',
  allowed_use TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_name, source_url)
);
ALTER TABLE public.crawl_watchlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_crawl_watchlist" ON public.crawl_watchlist FOR SELECT USING (true);
CREATE POLICY "service_role_full_crawl_watchlist" ON public.crawl_watchlist FOR ALL TO service_role USING (true) WITH CHECK (true);
