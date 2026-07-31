DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid FROM cron.job WHERE jobname LIKE 'qa-oneshot-%' LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
END
$do$;