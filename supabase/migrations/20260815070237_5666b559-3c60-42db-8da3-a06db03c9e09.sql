DO $$
BEGIN
  PERFORM public.civiko_admin_invoke_job('cron-padova-subito-promote','{}'::jsonb);
  PERFORM public.civiko_admin_invoke_job('padova-detail-enrich-collect','{"since_hours":6,"limit":20}'::jsonb);
END $$;