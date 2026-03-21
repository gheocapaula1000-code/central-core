
CREATE TABLE public.listing_bridge_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id text NOT NULL,
  listing_id text NOT NULL,
  run_id text NOT NULL,
  schema_version text NOT NULL DEFAULT '1.0',
  source_app text NOT NULL DEFAULT 'keydraft',
  source_environment text,
  status text NOT NULL DEFAULT 'received',
  payload jsonb NOT NULL,
  sottra_payload jsonb,
  sottra_response jsonb,
  warnings text[] DEFAULT '{}',
  error_message text,
  retry_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CONSTRAINT valid_status CHECK (status IN ('received','validated','transformed','delivered','imported','failed')),
  CONSTRAINT unique_trace UNIQUE (trace_id),
  CONSTRAINT unique_listing_run UNIQUE (listing_id, run_id)
);

ALTER TABLE public.listing_bridge_jobs ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_bridge_jobs_status ON public.listing_bridge_jobs (status);
CREATE INDEX idx_bridge_jobs_listing ON public.listing_bridge_jobs (listing_id);

COMMENT ON TABLE public.listing_bridge_jobs IS 'Listing bridge job tracker — KeyDraft→Sottra data transport via Central Core V3';
