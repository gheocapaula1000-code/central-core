CREATE TABLE public.provider_diagnostics_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('probe','test')),
  action TEXT,
  ok BOOLEAN NOT NULL,
  http_status INTEGER,
  latency_ms INTEGER,
  message TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_pde_provider_created ON public.provider_diagnostics_events (provider, created_at DESC);
CREATE INDEX idx_pde_ok_created ON public.provider_diagnostics_events (provider, ok, created_at DESC);

ALTER TABLE public.provider_diagnostics_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins can read diagnostics events"
ON public.provider_diagnostics_events
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));
