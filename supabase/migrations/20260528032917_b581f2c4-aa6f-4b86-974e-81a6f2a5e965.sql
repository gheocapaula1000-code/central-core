
-- ============================================================
-- 1. civiko_source_registry
-- ============================================================
CREATE TABLE public.civiko_source_registry (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source_code TEXT NOT NULL UNIQUE,
  source_name TEXT NOT NULL,
  source_url TEXT,
  refresh_frequency TEXT,
  access_type TEXT NOT NULL CHECK (access_type IN ('public_api','public_file','scraping','paid_gateway','manual_import')),
  compliance_level TEXT NOT NULL CHECK (compliance_level IN ('public','sensitive_aggregate','sensitive_restricted')),
  implementation_status TEXT NOT NULL CHECK (implementation_status IN ('live','partial','manual_import','planned','disabled')),
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  record_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.civiko_source_registry TO authenticated;
GRANT ALL ON public.civiko_source_registry TO service_role;

ALTER TABLE public.civiko_source_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "registry_admin_select" ON public.civiko_source_registry
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER civiko_source_registry_touch
  BEFORE UPDATE ON public.civiko_source_registry
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();

-- ============================================================
-- 2. padova_elderly_population (F4)
-- ============================================================
CREATE TABLE public.padova_elderly_population (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  year INTEGER NOT NULL,
  area_name TEXT NOT NULL,
  area_code TEXT,
  over_65_count INTEGER,
  over_75_count INTEGER,
  total_population INTEGER,
  over_75_rate NUMERIC GENERATED ALWAYS AS (
    CASE WHEN total_population > 0 AND over_75_count IS NOT NULL
         THEN over_75_count::NUMERIC / total_population::NUMERIC
         ELSE NULL END
  ) STORED,
  source_url TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, area_name)
);

GRANT SELECT ON public.padova_elderly_population TO authenticated;
GRANT ALL ON public.padova_elderly_population TO service_role;
ALTER TABLE public.padova_elderly_population ENABLE ROW LEVEL SECURITY;
CREATE POLICY "elderly_admin_select" ON public.padova_elderly_population
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- 3. istat_apr4_mobility (F3/F20)
-- ============================================================
CREATE TABLE public.istat_apr4_mobility (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  year INTEGER NOT NULL,
  comune TEXT NOT NULL,
  comune_istat TEXT NOT NULL,
  iscritti INTEGER,
  cancellati INTEGER,
  saldo_migratorio INTEGER,
  transfer_rate NUMERIC,
  source_url TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, comune_istat)
);

GRANT SELECT ON public.istat_apr4_mobility TO authenticated;
GRANT ALL ON public.istat_apr4_mobility TO service_role;
ALTER TABLE public.istat_apr4_mobility ENABLE ROW LEVEL SECURITY;
CREATE POLICY "apr4_admin_select" ON public.istat_apr4_mobility
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- 4. market_benchmark_padova (F12)
-- ============================================================
CREATE TABLE public.market_benchmark_padova (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  period TEXT NOT NULL,
  area_name TEXT NOT NULL,
  min_price_eur_mq NUMERIC,
  max_price_eur_mq NUMERIC,
  avg_price_eur_mq NUMERIC,
  rent_eur_mq_month NUMERIC,
  source_name TEXT NOT NULL,
  source_url TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (period, area_name, source_name)
);

GRANT SELECT ON public.market_benchmark_padova TO authenticated;
GRANT ALL ON public.market_benchmark_padova TO service_role;
ALTER TABLE public.market_benchmark_padova ENABLE ROW LEVEL SECURITY;
CREATE POLICY "market_admin_select" ON public.market_benchmark_padova
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- 5. sue_padova_permits (F18)
-- ============================================================
CREATE TABLE public.sue_padova_permits (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  area_name TEXT,
  address_public TEXT,
  practice_type TEXT,
  practice_date DATE,
  status TEXT,
  source_url TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  compliance_verified BOOLEAN NOT NULL DEFAULT false
);

GRANT SELECT ON public.sue_padova_permits TO authenticated;
GRANT ALL ON public.sue_padova_permits TO service_role;
ALTER TABLE public.sue_padova_permits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sue_admin_select" ON public.sue_padova_permits
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- 6. istat_separations_padova (F22)
-- ============================================================
CREATE TABLE public.istat_separations_padova (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  year INTEGER NOT NULL,
  comune TEXT NOT NULL,
  comune_istat TEXT NOT NULL,
  separations_count INTEGER,
  divorces_count INTEGER,
  marriages_count INTEGER,
  separation_rate NUMERIC,
  divorce_rate NUMERIC,
  source_url TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, comune_istat)
);

GRANT SELECT ON public.istat_separations_padova TO authenticated;
GRANT ALL ON public.istat_separations_padova TO service_role;
ALTER TABLE public.istat_separations_padova ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sep_admin_select" ON public.istat_separations_padova
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- 7. restricted_report_audit (F15 gate)
-- ============================================================
CREATE TABLE public.restricted_report_audit (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agency_id UUID,
  feature_code TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  provider_response_id TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','authorized','completed','failed','denied')),
  error_message TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX restricted_report_audit_user_idx ON public.restricted_report_audit (user_id, requested_at DESC);
CREATE INDEX restricted_report_audit_feature_idx ON public.restricted_report_audit (feature_code, requested_at DESC);

GRANT SELECT, INSERT ON public.restricted_report_audit TO authenticated;
GRANT ALL ON public.restricted_report_audit TO service_role;
ALTER TABLE public.restricted_report_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_user_select_own" ON public.restricted_report_audit
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "audit_user_insert_own" ON public.restricted_report_audit
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- 8. Seed registry rows
-- ============================================================
INSERT INTO public.civiko_source_registry
  (source_code, source_name, source_url, refresh_frequency, access_type, compliance_level, implementation_status, notes)
VALUES
  ('F3','ISTAT APR4 - Iscritti residenza','https://demo.istat.it/','annual','public_file','public','planned','Aggregato comunale; importer CSV o pull HTTP.'),
  ('F4','Comune Padova - Popolazione anziana','https://www.padovanet.it/informazione/popolazione','annual','manual_import','public','planned','PDF/CSV per quartiere; import manuale via CSV admin.'),
  ('F12','Borsino Immobiliare / FIAIP - Benchmark prezzi','https://www.borsinoimmobiliare.it/','quarterly','manual_import','public','planned','Solo cross-check OMI; no scraping (TOS).'),
  ('F15','Conservatoria / Ipotecarie via OpenAPI.it','https://oc.openapi.it/','on_demand','paid_gateway','sensitive_restricted','disabled','Paid + gated: feature flag F15_CONSERVATORIA_ENABLED, audit, cost ledger.'),
  ('F17','Veneto APE - Registro ufficiale','https://www.regione.veneto.it/','on_demand','public_api','public','partial','Attuale: stima AI etichettata. Registro ufficiale: planned.'),
  ('F18','Comune Padova - SUE pratiche edilizie','https://opendata.comune.padova.it/','monthly','manual_import','public','planned','Solo pratiche pubbliche con compliance_verified=true.'),
  ('F20','ISTAT APR4 - Cancellati residenza','https://demo.istat.it/','annual','public_file','public','planned','Stessa importazione di F3, campo cancellati.'),
  ('F22','ISTAT - Separazioni/divorzi','https://www.istat.it/it/separazioni-e-divorzi','annual','public_file','sensitive_aggregate','planned','Solo aggregato comunale; mai person-level.')
ON CONFLICT (source_code) DO NOTHING;
