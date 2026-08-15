DO $$
DECLARE v_id bigint;
BEGIN
  SELECT public.civiko_admin_invoke_job('cron-radar-padova-nightly?mode=full&force=1','{}'::jsonb) INTO v_id;
  RAISE NOTICE 'full request %', v_id;
END $$;