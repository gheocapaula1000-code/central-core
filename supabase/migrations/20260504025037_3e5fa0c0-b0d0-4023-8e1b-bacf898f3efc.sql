-- ============================================================
-- 1. Estensione listing_price_snapshots per identity tracking
-- ============================================================
ALTER TABLE public.listing_price_snapshots
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS agency_name text,
  ADD COLUMN IF NOT EXISTS surface_sqm integer,
  ADD COLUMN IF NOT EXISTS rooms integer,
  ADD COLUMN IF NOT EXISTS property_type text,
  ADD COLUMN IF NOT EXISTS identity_hash text;

CREATE INDEX IF NOT EXISTS idx_lps_identity_hash ON public.listing_price_snapshots(identity_hash) WHERE identity_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lps_listing_captured ON public.listing_price_snapshots(listing_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_lps_municipality_captured ON public.listing_price_snapshots(municipality, captured_at DESC);

-- ============================================================
-- 2. listing_identity — cross-portal matching
-- ============================================================
CREATE TABLE IF NOT EXISTS public.listing_identity (
  id bigserial PRIMARY KEY,
  identity_hash text NOT NULL UNIQUE,
  lat_rounded numeric(8,4),
  lng_rounded numeric(8,4),
  surface_sqm integer,
  property_type text,
  rooms integer,
  municipality text,
  province text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  sources_seen text[] NOT NULL DEFAULT '{}',
  agencies_seen text[] NOT NULL DEFAULT '{}',
  listing_ids_seen text[] NOT NULL DEFAULT '{}',
  observation_count integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_li_municipality ON public.listing_identity(municipality);
CREATE INDEX IF NOT EXISTS idx_li_last_seen ON public.listing_identity(last_seen_at DESC);

ALTER TABLE public.listing_identity ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_full_li ON public.listing_identity FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 3. market_anomalies — Anomalia di Mercato
-- ============================================================
CREATE TABLE IF NOT EXISTS public.market_anomalies (
  id bigserial PRIMARY KEY,
  identity_hash text NOT NULL,
  anomaly_type text NOT NULL CHECK (anomaly_type IN ('cross_portal_reappear','agency_swap','price_jump_after_disappear','duplicate_listing')),
  municipality text,
  province text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ma_identity ON public.market_anomalies(identity_hash);
CREATE INDEX IF NOT EXISTS idx_ma_municipality_active ON public.market_anomalies(municipality, is_active);

ALTER TABLE public.market_anomalies ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_full_ma ON public.market_anomalies FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 4. motivated_sellers — Lead caldissimo
-- ============================================================
CREATE TABLE IF NOT EXISTS public.motivated_sellers (
  id bigserial PRIMARY KEY,
  identity_hash text NOT NULL,
  listing_id text,
  source text,
  url text,
  municipality text,
  province text,
  first_seen_at timestamptz NOT NULL,
  last_price_eur numeric,
  initial_price_eur numeric,
  total_drop_pct numeric,
  drops_count integer NOT NULL DEFAULT 0,
  days_online integer NOT NULL DEFAULT 0,
  fatigue_score numeric NOT NULL DEFAULT 0,
  fatigue_label text NOT NULL CHECK (fatigue_label IN ('caldissimo','caldo','tiepido')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (identity_hash, detected_at)
);
CREATE INDEX IF NOT EXISTS idx_ms_municipality_label ON public.motivated_sellers(municipality, fatigue_label);
CREATE INDEX IF NOT EXISTS idx_ms_active ON public.motivated_sellers(is_active, detected_at DESC);

ALTER TABLE public.motivated_sellers ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_full_ms ON public.motivated_sellers FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 5. price_resistance_index — Indice provinciale
-- ============================================================
CREATE TABLE IF NOT EXISTS public.price_resistance_index (
  id bigserial PRIMARY KEY,
  province text NOT NULL,
  region text NOT NULL DEFAULT 'veneto',
  computed_at timestamptz NOT NULL DEFAULT now(),
  sample_size integer NOT NULL,
  avg_asking_price_eur numeric,
  avg_omi_compr_max_eur numeric,
  avg_gap_pct numeric,
  resistance_label text CHECK (resistance_label IN ('molto_alta','alta','media','bassa','molto_bassa')),
  methodology_note text NOT NULL,
  UNIQUE (province, computed_at)
);
CREATE INDEX IF NOT EXISTS idx_pri_province_recent ON public.price_resistance_index(province, computed_at DESC);

ALTER TABLE public.price_resistance_index ENABLE ROW LEVEL SECURITY;
CREATE POLICY public_read_pri ON public.price_resistance_index FOR SELECT TO public USING (true);
CREATE POLICY service_role_full_pri ON public.price_resistance_index FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 6. succession_heatmap_cap — Heatmap CAP
-- ============================================================
CREATE TABLE IF NOT EXISTS public.succession_heatmap_cap (
  id bigserial PRIMARY KEY,
  cap text NOT NULL,
  region text NOT NULL DEFAULT 'veneto',
  province text,
  municipality_main text,
  computed_at timestamptz NOT NULL DEFAULT now(),
  obituaries_90d integer NOT NULL DEFAULT 0,
  indice_vecchiaia_avg numeric,
  pct_residential_omi numeric,
  probability_score numeric NOT NULL,
  probability_label text NOT NULL CHECK (probability_label IN ('molto_alta','alta','media','bassa')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (cap, computed_at)
);
CREATE INDEX IF NOT EXISTS idx_shc_cap ON public.succession_heatmap_cap(cap);
CREATE INDEX IF NOT EXISTS idx_shc_recent ON public.succession_heatmap_cap(computed_at DESC);

ALTER TABLE public.succession_heatmap_cap ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_full_shc ON public.succession_heatmap_cap FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 7. obituaries_seen — add cap column for heatmap aggregation
-- ============================================================
ALTER TABLE public.obituaries_seen
  ADD COLUMN IF NOT EXISTS cap text;
CREATE INDEX IF NOT EXISTS idx_obs_cap_captured ON public.obituaries_seen(cap, captured_at DESC) WHERE cap IS NOT NULL;