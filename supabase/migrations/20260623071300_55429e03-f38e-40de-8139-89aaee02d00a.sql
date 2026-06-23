DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'cron.job does not exist, skipping cron cleanup';
    RETURN;
  END IF;

  FOR r IN
    SELECT jobid, jobname
    FROM cron.job
  LOOP
    BEGIN
      IF r.jobname IS NOT NULL THEN
        PERFORM cron.unschedule(r.jobname);
        RAISE NOTICE 'Unscheduled cron job by name: %', r.jobname;
      ELSE
        PERFORM cron.unschedule(r.jobid);
        RAISE NOTICE 'Unscheduled cron job by id: %', r.jobid;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM cron.unschedule(r.jobid);
        RAISE NOTICE 'Unscheduled cron job by fallback id: %', r.jobid;
      EXCEPTION WHEN OTHERS THEN
        UPDATE cron.job
        SET active = false
        WHERE jobid = r.jobid;
        RAISE NOTICE 'Could not unschedule job %, set active=false instead', r.jobid;
      END;
    END;
  END LOOP;
END $$;