-- TrovaBandi — backfill_nulls: batch a centinaia, scrittura, timeout 180s.
-- Non tocca i collect notturni né Civiko/Padova.

DO $$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'trovabandi-night-backfill',
    'trovabandi-day-backfill'
  ] LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
        PERFORM cron.unschedule(j);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

SELECT cron.schedule(
  'trovabandi-night-backfill',
  '10 23 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"backfill_nulls","max_batch":250,"dry_run":false,"allow_paid_extract":false,"trigger_source":"supabase-cron"}'::jsonb,
    180000
  ); $c$
);

SELECT cron.schedule(
  'trovabandi-day-backfill',
  '30 8 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"backfill_nulls","max_batch":250,"dry_run":false,"allow_paid_extract":false,"trigger_source":"supabase-cron"}'::jsonb,
    180000
  ); $c$
);
