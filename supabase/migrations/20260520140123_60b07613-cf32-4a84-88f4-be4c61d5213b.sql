
-- Evidence ledger territoriale Padova
CREATE TABLE IF NOT EXISTS public.evidence_source_registry (
  id bigserial PRIMARY KEY,
  source_name text NOT NULL UNIQUE,
  default_geo_level text NOT NULL CHECK (default_geo_level IN ('exact_address','street','microzone','district','city_level')),
  default_weight numeric NOT NULL DEFAULT 0.2 CHECK (default_weight >= 0 AND default_weight <= 1),
  default_anticipatory text NOT NULL DEFAULT 'context' CHECK (default_anticipatory IN ('anticipatory','confirmation','context')),
  privacy_class text NOT NULL DEFAULT 'safe' CHECK (privacy_class IN ('safe','sensitive','forbidden')),
  priority_rank integer NOT NULL DEFAULT 99,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.evidence_source_registry ENABLE ROW LEVEL SECURITY;
CREATE POLICY public_read_esr ON public.evidence_source_registry FOR SELECT TO public USING (true);
CREATE POLICY service_role_full_esr ON public.evidence_source_registry FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.opportunity_evidence (
  id bigserial PRIMARY KEY,
  opportunity_id bigint NOT NULL,
  opportunity_table text NOT NULL DEFAULT 'early_warning_opportunities',
  source_name text NOT NULL,
  source_url text NOT NULL,
  geo_level text NOT NULL CHECK (geo_level IN ('exact_address','street','microzone','district','city_level')),
  signal_type text NOT NULL,
  freshness_days integer,
  anticipatory_or_confirmation text NOT NULL CHECK (anticipatory_or_confirmation IN ('anticipatory','confirmation','context')),
  score_weight numeric NOT NULL DEFAULT 0 CHECK (score_weight >= 0 AND score_weight <= 1),
  privacy_safe boolean NOT NULL DEFAULT true,
  reason_for_weight text NOT NULL,
  area_match jsonb NOT NULL DEFAULT '{}'::jsonb,
  collected_at timestamptz NOT NULL DEFAULT now(),
  fingerprint text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_oe_opportunity ON public.opportunity_evidence(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_oe_geo ON public.opportunity_evidence(geo_level);
CREATE INDEX IF NOT EXISTS idx_oe_signal ON public.opportunity_evidence(signal_type);

ALTER TABLE public.opportunity_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY public_read_oe ON public.opportunity_evidence FOR SELECT TO public USING (privacy_safe = true);
CREATE POLICY service_role_full_oe ON public.opportunity_evidence FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Seed registry per fonti note
INSERT INTO public.evidence_source_registry (source_name, default_geo_level, default_weight, default_anticipatory, privacy_class, priority_rank, notes) VALUES
  ('padova_civici',           'exact_address', 0.95, 'context',       'safe', 1, 'Numeri civici Padova (anchor territoriale)'),
  ('omi',                     'microzone',     0.85, 'context',       'safe', 2, 'Zone OMI Agenzia Entrate'),
  ('rndt_geoportale',         'street',        0.70, 'context',       'safe', 3, 'Geoportali nazionali/RNDT'),
  ('comune_padova_avvisi',    'district',      0.55, 'anticipatory',  'safe', 4, 'Avvisi pubblici Comune Padova'),
  ('comune_padova_patrimonio','city_level',    0.25, 'confirmation',  'safe', 4, 'Patrimonio comunale aggregato (city-level)'),
  ('comune_padova_rss',       'district',      0.55, 'anticipatory',  'safe', 4, 'RSS Comune Padova'),
  ('pvp',                     'street',        0.85, 'confirmation',  'safe', 5, 'Portale Vendite Pubbliche'),
  ('tribunale_padova',        'street',        0.80, 'confirmation',  'safe', 5, 'Tribunale Padova'),
  ('asteimmobili.it (Astalegale)','city_level',0.30,'confirmation','safe', 5, 'Aste aggregate city-level'),
  ('casa.it',                 'city_level',    0.30, 'confirmation',  'safe', 6, 'Listing pubblico city-level (richiede street disambiguation)'),
  ('immobiliare.it',          'city_level',    0.30, 'confirmation',  'safe', 7, '2a fonte listing'),
  ('istat',                   'city_level',    0.15, 'context',       'safe', 8, 'Contesto demografico'),
  ('cciaa',                   'city_level',    0.15, 'context',       'safe', 8, 'Contesto economico'),
  ('arpav',                   'district',      0.20, 'context',       'safe', 8, 'Qualita ambientale'),
  ('osm',                     'street',        0.25, 'context',       'safe', 8, 'OpenStreetMap geometry')
ON CONFLICT (source_name) DO NOTHING;
