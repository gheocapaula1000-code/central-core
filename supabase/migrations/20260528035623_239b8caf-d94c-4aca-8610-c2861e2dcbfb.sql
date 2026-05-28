
CREATE TABLE IF NOT EXISTS public.obituaries_aggregate_padova (
  id BIGSERIAL PRIMARY KEY,
  area_type TEXT NOT NULL CHECK (area_type IN ('cap','microzone','area')),
  area_code TEXT NOT NULL,
  window_start DATE NOT NULL,
  window_end DATE NOT NULL,
  window_days INTEGER NOT NULL CHECK (window_days >= 30),
  bucket_count INTEGER NOT NULL CHECK (bucket_count >= 3),
  source_url TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (area_type, area_code, window_start, window_end)
);

COMMENT ON TABLE public.obituaries_aggregate_padova IS
  'F19 necrologi aggregate-only. K-anonymity enforced (bucket_count >= 3). No person-level data. Service-role only.';

GRANT ALL ON public.obituaries_aggregate_padova TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.obituaries_aggregate_padova_id_seq TO service_role;

ALTER TABLE public.obituaries_aggregate_padova ENABLE ROW LEVEL SECURITY;

UPDATE public.civiko_source_registry
SET
  implementation_status = 'live',
  activation_mode       = 'aggregate_only',
  compliance_level      = 'sensitive_aggregate',
  freshness_days        = 90,
  notes = COALESCE(notes, '') ||
          ' [F19 active aggregate-only: counts per CAP/microzone, k-anonymity>=3, 90d window. Person-level obituary tables remain locked.]'
WHERE source_code = 'F19';
