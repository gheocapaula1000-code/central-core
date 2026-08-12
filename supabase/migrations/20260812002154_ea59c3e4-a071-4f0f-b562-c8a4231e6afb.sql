CREATE TABLE IF NOT EXISTS public.trovabandi_refresh_requests_log_tmp (
  id bigserial PRIMARY KEY,
  request_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.trovabandi_refresh_requests_log_tmp TO service_role;
ALTER TABLE public.trovabandi_refresh_requests_log_tmp ENABLE ROW LEVEL SECURITY;

INSERT INTO public.trovabandi_refresh_requests_log_tmp(request_id)
SELECT net.http_post(
  url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/trovabandi-engine',
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'x-job-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CENTRAL_CORE_JOB_SECRET' LIMIT 1)
  ),
  body := '{"action":"backfill_nulls","max_batch":12,"dry_run":false}'::jsonb,
  timeout_milliseconds := 120000
);