
DO $r$
DECLARE res jsonb;
BEGIN
  res := public.recompute_padova_listings_contendibili();
  RAISE NOTICE 'recompute: %', res;
  INSERT INTO public.cron_executions_log(job_name, status, details)
  VALUES ('p1b_recompute_manual', 'success', res)
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN
  NULL;
END
$r$;
