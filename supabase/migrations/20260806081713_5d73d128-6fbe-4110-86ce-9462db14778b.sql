CREATE TABLE IF NOT EXISTS public.trovabandi_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  authority_level text NOT NULL CHECK (authority_level IN ('EU', 'NAZIONALE', 'REGIONALE', 'CAMERALE', 'COMUNALE')),
  region text,
  province text,
  official_domain text NOT NULL,
  search_query text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  priority smallint NOT NULL DEFAULT 50 CHECK (priority BETWEEN 1 AND 100),
  last_scanned_at timestamptz,
  next_scan_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (official_domain, search_query)
);

CREATE INDEX IF NOT EXISTS trovabandi_sources_due_idx
  ON public.trovabandi_sources (enabled, next_scan_at, priority DESC);

CREATE TABLE IF NOT EXISTS public.trovabandi_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key text NOT NULL UNIQUE,
  title text NOT NULL,
  authority_name text NOT NULL,
  authority_level text NOT NULL CHECK (authority_level IN ('EU', 'NAZIONALE', 'REGIONALE', 'CAMERALE', 'COMUNALE')),
  category text NOT NULL CHECK (category IN (
    'FONDO_PERDUTO', 'FINANZIAMENTO_AGEVOLATO', 'TASSO_ZERO', 'CREDITO_IMPOSTA',
    'GARANZIA', 'VOUCHER', 'IMPRENDITORIA_FEMMINILE', 'IMPRENDITORIA_GIOVANILE',
    'DIGITALIZZAZIONE', 'TRANSIZIONE_ENERGETICA', 'RICERCA_SVILUPPO', 'INTERNAZIONALIZZAZIONE', 'ALTRO'
  )),
  summary text NOT NULL,
  official_url text NOT NULL UNIQUE,
  notice_url text,
  application_url text,
  forms_url text,
  protocol_email text,
  region text,
  province text,
  municipality text,
  eligible_ateco_prefixes text[] NOT NULL DEFAULT '{}',
  excluded_ateco_prefixes text[] NOT NULL DEFAULT '{}',
  eligible_legal_forms text[] NOT NULL DEFAULT '{}',
  eligible_company_sizes text[] NOT NULL DEFAULT '{}',
  female_only boolean NOT NULL DEFAULT false,
  youth_only boolean NOT NULL DEFAULT false,
  startup_only boolean NOT NULL DEFAULT false,
  innovative_only boolean NOT NULL DEFAULT false,
  de_minimis boolean,
  aid_intensity_percent numeric(6,2),
  min_grant_amount numeric(15,2),
  max_grant_amount numeric(15,2),
  total_budget numeric(18,2),
  opens_at timestamptz,
  deadline_at timestamptz,
  click_day boolean NOT NULL DEFAULT false,
  requirements text[] NOT NULL DEFAULT '{}',
  eligible_expenses text[] NOT NULL DEFAULT '{}',
  verification_status text NOT NULL DEFAULT 'DA_VERIFICARE'
    CHECK (verification_status IN ('VERIFICATO', 'PARZIALE', 'DA_VERIFICARE', 'SCADUTO', 'RITIRATO')),
  official_source boolean NOT NULL DEFAULT false,
  discovered_by text[] NOT NULL DEFAULT '{}',
  content_hash text,
  raw_excerpt text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trovabandi_opportunities_active_idx
  ON public.trovabandi_opportunities (verification_status, deadline_at, authority_level);
CREATE INDEX IF NOT EXISTS trovabandi_opportunities_region_idx
  ON public.trovabandi_opportunities (lower(region), lower(province));
CREATE INDEX IF NOT EXISTS trovabandi_opportunities_ateco_idx
  ON public.trovabandi_opportunities USING gin (eligible_ateco_prefixes);

CREATE TABLE IF NOT EXISTS public.trovabandi_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES public.trovabandi_opportunities(id) ON DELETE CASCADE,
  source_url text NOT NULL,
  source_title text,
  evidence_type text NOT NULL CHECK (evidence_type IN ('OFFICIAL_PAGE', 'NOTICE', 'PDF', 'FORM', 'SEARCH_RESULT')),
  excerpt text,
  published_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  content_hash text,
  UNIQUE (opportunity_id, source_url)
);

CREATE INDEX IF NOT EXISTS trovabandi_evidence_opportunity_idx
  ON public.trovabandi_evidence (opportunity_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS public.trovabandi_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  source_id uuid REFERENCES public.trovabandi_sources(id) ON DELETE SET NULL,
  trigger_source text NOT NULL DEFAULT 'replit',
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'SKIPPED')),
  discovered_count integer NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  verified_count integer NOT NULL DEFAULT 0,
  provider_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings text[] NOT NULL DEFAULT '{}',
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS trovabandi_runs_started_idx
  ON public.trovabandi_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS public.trovabandi_refresh_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key text NOT NULL,
  region text,
  province text,
  ateco_prefix text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (request_key)
);

ALTER TABLE public.trovabandi_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trovabandi_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trovabandi_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trovabandi_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trovabandi_refresh_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.trovabandi_sources FROM anon, authenticated;
REVOKE ALL ON public.trovabandi_opportunities FROM anon, authenticated;
REVOKE ALL ON public.trovabandi_evidence FROM anon, authenticated;
REVOKE ALL ON public.trovabandi_runs FROM anon, authenticated;
REVOKE ALL ON public.trovabandi_refresh_requests FROM anon, authenticated;
GRANT ALL ON public.trovabandi_sources TO service_role;
GRANT ALL ON public.trovabandi_opportunities TO service_role;
GRANT ALL ON public.trovabandi_evidence TO service_role;
GRANT ALL ON public.trovabandi_runs TO service_role;
GRANT ALL ON public.trovabandi_refresh_requests TO service_role;

INSERT INTO public.trovabandi_sources
  (name, authority_level, region, official_domain, search_query, priority)
VALUES
  ('Incentivi.gov.it', 'NAZIONALE', NULL, 'incentivi.gov.it', 'incentivi imprese bando aperto contributo fondo perduto', 100),
  ('Invitalia', 'NAZIONALE', NULL, 'invitalia.it', 'incentivi imprese domande aperte nuove imprese fondo perduto', 98),
  ('MIMIT', 'NAZIONALE', NULL, 'mimit.gov.it', 'agevolazioni imprese bando decreto domande', 96),
  ('Agenzia Entrate', 'NAZIONALE', NULL, 'agenziaentrate.gov.it', 'credito imposta imprese investimenti agevolazione', 90),
  ('Unioncamere', 'CAMERALE', NULL, 'unioncamere.gov.it', 'bando voucher contributi imprese camere commercio', 88),
  ('Funding & Tenders EU', 'EU', NULL, 'ec.europa.eu', 'funding calls SMEs Italy grants open call', 85),
  ('Regione Veneto', 'REGIONALE', 'Veneto', 'regione.veneto.it', 'bandi imprese contributi POR FESR fondo perduto', 95),
  ('Regione Lombardia', 'REGIONALE', 'Lombardia', 'regione.lombardia.it', 'bandi imprese contributi fondo perduto', 92),
  ('Regione Piemonte', 'REGIONALE', 'Piemonte', 'regione.piemonte.it', 'bandi imprese contributi fondo perduto', 90),
  ('Regione Emilia-Romagna', 'REGIONALE', 'Emilia-Romagna', 'regione.emilia-romagna.it', 'bandi imprese contributi fondo perduto', 90),
  ('Regione Toscana', 'REGIONALE', 'Toscana', 'regione.toscana.it', 'bandi imprese contributi fondo perduto', 90),
  ('Regione Lazio', 'REGIONALE', 'Lazio', 'regione.lazio.it', 'bandi imprese contributi fondo perduto', 90),
  ('Regione Campania', 'REGIONALE', 'Campania', 'regione.campania.it', 'bandi imprese contributi fondo perduto', 90),
  ('Regione Puglia', 'REGIONALE', 'Puglia', 'regione.puglia.it', 'bandi imprese contributi fondo perduto', 90),
  ('Regione Sicilia', 'REGIONALE', 'Sicilia', 'regione.sicilia.it', 'bandi imprese contributi fondo perduto', 90),
  ('Regione Sardegna', 'REGIONALE', 'Sardegna', 'regione.sardegna.it', 'bandi imprese contributi fondo perduto', 90)
ON CONFLICT (official_domain, search_query) DO UPDATE SET
  name = EXCLUDED.name,
  authority_level = EXCLUDED.authority_level,
  region = EXCLUDED.region,
  priority = EXCLUDED.priority,
  enabled = true,
  updated_at = now();

COMMENT ON TABLE public.trovabandi_opportunities IS
  'Authoritative grant catalogue for TrovaBandi. Service-role only; exposed through the dedicated edge function.';