CREATE OR REPLACE FUNCTION public.get_cron_job_last_runs(p_job_names text[])
RETURNS TABLE (
  jobname text,
  status text,
  start_time timestamptz,
  end_time timestamptz,
  return_message text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, cron
AS $$
  SELECT j.jobname::text, d.status::text, d.start_time, d.end_time, d.return_message::text
  FROM cron.job j
  JOIN LATERAL (
    SELECT status, start_time, end_time, return_message
    FROM cron.job_run_details
    WHERE jobid = j.jobid
    ORDER BY start_time DESC
    LIMIT 1
  ) d ON true
  WHERE j.jobname = ANY(p_job_names);
$$;

REVOKE ALL ON FUNCTION public.get_cron_job_last_runs(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_cron_job_last_runs(text[]) TO service_role;