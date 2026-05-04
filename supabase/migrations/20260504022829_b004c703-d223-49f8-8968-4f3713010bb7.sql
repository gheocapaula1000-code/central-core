-- 1. Snapshot prezzi annunci (per drop detection)
CREATE TABLE IF NOT EXISTS public.listing_price_snapshots (
  id BIGSERIAL PRIMARY KEY,
  listing_id TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  price_eur NUMERIC(12,2),
  municipality TEXT,
  province TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  raw_title TEXT,
  raw_address TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lps_listing_captured ON public.listing_price_snapshots(listing_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_lps_municipality ON public.listing_price_snapshots(municipality);
ALTER TABLE public.listing_price_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_lps" ON public.listing_price_snapshots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. Necrologi raccolti (pseudonimizzati: solo cognome + comune)
CREATE TABLE IF NOT EXISTS public.obituaries_seen (
  id BIGSERIAL PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE, -- sha256(cognome|comune|data)
  surname TEXT NOT NULL,
  municipality TEXT NOT NULL,
  province TEXT,
  death_date DATE,
  source_id BIGINT,
  source_url TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  omi_link_zona TEXT,
  omi_zona_descr TEXT,
  omi_tipologia TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ob_municipality_captured ON public.obituaries_seen(municipality, captured_at DESC);
ALTER TABLE public.obituaries_seen ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_ob" ON public.obituaries_seen
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Fonti necrologi configurabili
CREATE TABLE IF NOT EXISTS public.obituaries_sources (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  search_url_template TEXT NOT NULL, -- es. https://www.necrologie.it/cerca?citta={municipality}
  source_type TEXT NOT NULL DEFAULT 'aggregator', -- aggregator | comune | parrocchia
  region TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  reliability_score NUMERIC(3,2),
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.obituaries_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_obs" ON public.obituaries_sources
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "public_read_active_obs" ON public.obituaries_sources
  FOR SELECT TO public USING (is_active = true);

-- Seed iniziale fonti Veneto (aggregatori privati + base pubblica)
INSERT INTO public.obituaries_sources (name, base_url, search_url_template, source_type, region, reliability_score)
VALUES
  ('Necrologie.it', 'https://www.necrologie.it', 'https://www.necrologie.it/necrologi/{region}/{municipality}', 'aggregator', 'veneto', 0.70),
  ('Il Gazzettino - Necrologie', 'https://necrologie.ilgazzettino.it', 'https://necrologie.ilgazzettino.it/citta/{municipality}', 'aggregator', 'veneto', 0.80),
  ('Lutto.it Veneto', 'https://www.lutto.it', 'https://www.lutto.it/necrologi/veneto/{municipality}', 'aggregator', 'veneto', 0.65)
ON CONFLICT DO NOTHING;

-- 4. Log esecuzioni radar
CREATE TABLE IF NOT EXISTS public.radar_run_log (
  id BIGSERIAL PRIMARY KEY,
  agency_id UUID,
  region TEXT NOT NULL DEFAULT 'veneto',
  municipality TEXT,
  module TEXT NOT NULL, -- ribassi | successioni | aste | etc
  status TEXT NOT NULL, -- success | partial | error
  results_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  warnings JSONB DEFAULT '[]'::jsonb,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_rrl_agency_started ON public.radar_run_log(agency_id, started_at DESC);
ALTER TABLE public.radar_run_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_rrl" ON public.radar_run_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "agency_read_own_rrl" ON public.radar_run_log
  FOR SELECT TO authenticated USING (agency_id = auth.uid());

-- 5. Segnali radar persistiti (dedup + storia)
CREATE TABLE IF NOT EXISTS public.radar_signals (
  id BIGSERIAL PRIMARY KEY,
  agency_id UUID,
  fingerprint TEXT NOT NULL,
  signal_type TEXT NOT NULL, -- ribasso | successione | asta | nuova_costruzione
  title TEXT NOT NULL,
  description TEXT,
  municipality TEXT,
  province TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  evidence_url TEXT,
  source TEXT,
  confidence TEXT NOT NULL DEFAULT 'medium',
  urgency TEXT NOT NULL DEFAULT 'media',
  payload JSONB DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_rs_agency_fp ON public.radar_signals(agency_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_rs_municipality_active ON public.radar_signals(municipality, is_active);
ALTER TABLE public.radar_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_rs" ON public.radar_signals
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "agency_read_own_rs" ON public.radar_signals
  FOR SELECT TO authenticated USING (agency_id = auth.uid());

-- 6. ISTAT comuni: estensione fasce età avanzate
ALTER TABLE public.istat_comuni
  ADD COLUMN IF NOT EXISTS percentuale_75_84 NUMERIC,
  ADD COLUMN IF NOT EXISTS percentuale_over85 NUMERIC,
  ADD COLUMN IF NOT EXISTS indice_vecchiaia NUMERIC,
  ADD COLUMN IF NOT EXISTS provincia TEXT,
  ADD COLUMN IF NOT EXISTS regione TEXT;

CREATE INDEX IF NOT EXISTS idx_istat_provincia ON public.istat_comuni(provincia);
CREATE INDEX IF NOT EXISTS idx_istat_regione ON public.istat_comuni(regione);