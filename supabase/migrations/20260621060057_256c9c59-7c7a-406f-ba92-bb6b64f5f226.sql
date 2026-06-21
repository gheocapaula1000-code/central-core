-- 1) Re-schedule cron job 53 with a robust DO block that always logs success/failure
SELECT cron.unschedule(53);

SELECT cron.schedule(
  'padova-contendibili-recompute',
  '15 3 * * *',
  $cron$
  DO $body$
  DECLARE
    v_log_id bigint;
    v_r1 jsonb;
    v_r2 jsonb;
    v_started timestamptz := now();
  BEGIN
    INSERT INTO public.cron_executions_log (job_name, status, triggered_at)
    VALUES ('padova-contendibili-recompute', 'started', v_started)
    RETURNING id INTO v_log_id;

    BEGIN
      v_r1 := public.recompute_padova_contendibili();
      v_r2 := public.recompute_padova_contendibili_extras();

      UPDATE public.cron_executions_log
         SET status = 'success',
             completed_at = now(),
             duration_ms = (EXTRACT(EPOCH FROM (now() - v_started)) * 1000)::int,
             response_excerpt = LEFT(
               'recompute=' || v_r1::text || ' | extras=' || v_r2::text,
               4000
             )
       WHERE id = v_log_id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.cron_executions_log
         SET status = 'failure',
             completed_at = now(),
             duration_ms = (EXTRACT(EPOCH FROM (now() - v_started)) * 1000)::int,
             error_message = LEFT(
               COALESCE(SQLSTATE, '') || ' ' || COALESCE(SQLERRM, '') ||
               ' | recompute=' || COALESCE(v_r1::text, 'NOT_RUN') ||
               ' | extras=' || COALESCE(v_r2::text, 'NOT_RUN'),
               4000
             )
       WHERE id = v_log_id;
    END;
  END;
  $body$;
  $cron$
);

-- 2) Trigger an immediate run so we have a fresh successful log row today
DO $$
DECLARE
  v_log_id bigint;
  v_r1 jsonb;
  v_r2 jsonb;
  v_started timestamptz := now();
BEGIN
  INSERT INTO public.cron_executions_log (job_name, status, triggered_at)
  VALUES ('padova-contendibili-recompute', 'started', v_started)
  RETURNING id INTO v_log_id;
  BEGIN
    v_r1 := public.recompute_padova_contendibili();
    v_r2 := public.recompute_padova_contendibili_extras();
    UPDATE public.cron_executions_log
       SET status = 'success', completed_at = now(),
           duration_ms = (EXTRACT(EPOCH FROM (now() - v_started)) * 1000)::int,
           response_excerpt = LEFT('manual re-run | recompute=' || v_r1::text || ' | extras=' || v_r2::text, 4000)
     WHERE id = v_log_id;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.cron_executions_log
       SET status = 'failure', completed_at = now(),
           duration_ms = (EXTRACT(EPOCH FROM (now() - v_started)) * 1000)::int,
           error_message = LEFT(COALESCE(SQLSTATE,'') || ' ' || COALESCE(SQLERRM,''), 4000)
     WHERE id = v_log_id;
  END;
END;
$$;

-- 3) Mark the orphaned 'started' row from the 03:15 UTC failure as failure with explicit reason
UPDATE public.cron_executions_log
   SET status = 'failure',
       completed_at = now(),
       error_message = 'Run orphaned: vecchio comando cron usava un singolo CTE INSERT+UPDATE; UPDATE non eseguito (probabile timeout o interruzione worker). Nessuno stack trace catturato. Cron riscritto con DO+EXCEPTION per catturare errori futuri.'
 WHERE id = 76
   AND status = 'started';