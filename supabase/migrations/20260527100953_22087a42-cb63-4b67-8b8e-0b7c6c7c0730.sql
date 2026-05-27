
CREATE TABLE public.openapi_it_cache (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cache_key text NOT NULL UNIQUE,
  endpoint text NOT NULL,
  normalized_address text,
  lat_scaled integer,
  lng_scaled integer,
  property_type text,
  contract text,
  request_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_openapi_it_cache_lookup
  ON public.openapi_it_cache (endpoint, normalized_address, property_type, contract);
CREATE INDEX idx_openapi_it_cache_coords
  ON public.openapi_it_cache (endpoint, lat_scaled, lng_scaled, property_type, contract);
CREATE INDEX idx_openapi_it_cache_expires
  ON public.openapi_it_cache (expires_at);

GRANT ALL ON public.openapi_it_cache TO service_role;

ALTER TABLE public.openapi_it_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "openapi_it_cache service only"
  ON public.openapi_it_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);


CREATE TABLE public.openapi_it_call_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  endpoint text NOT NULL,
  user_id uuid,
  agency_id uuid,
  dossier_id uuid,
  cache_hit boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  http_status integer,
  estimated_cost_eur numeric(10,4) NOT NULL DEFAULT 0,
  debug_id text,
  error_code text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_openapi_it_call_log_created ON public.openapi_it_call_log (created_at DESC);
CREATE INDEX idx_openapi_it_call_log_agency ON public.openapi_it_call_log (agency_id, created_at DESC);
CREATE INDEX idx_openapi_it_call_log_user ON public.openapi_it_call_log (user_id, created_at DESC);

GRANT ALL ON public.openapi_it_call_log TO service_role;

ALTER TABLE public.openapi_it_call_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "openapi_it_call_log service only"
  ON public.openapi_it_call_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
