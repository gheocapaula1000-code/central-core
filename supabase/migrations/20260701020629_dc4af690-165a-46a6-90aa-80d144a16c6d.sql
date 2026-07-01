DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'central-core-padova-contendibili-recompute';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'central-core-padova-contendibili-recompute',
  '15 3 * * *',
  $$SELECT public.recompute_padova_contendibili();$$
);