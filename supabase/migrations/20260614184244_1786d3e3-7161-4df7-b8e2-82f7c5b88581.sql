
CREATE OR REPLACE FUNCTION public.tick_padova_firecrawl_collect()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'net'
AS $function$
DECLARE
  v_job_id text := '01a1368e-d0b1-4b85-8778-f197891efe1a';
  v_spend_cap numeric := 15.0;
  v_spent numeric;
  v_status text;
  v_remaining bigint;
  v_url text;
  v_anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpwdW5uemdpeGNnaHV5ZHN0ZGx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzMDE1NzcsImV4cCI6MjA4Nzg3NzU3N30.aZSVcHq76DGZv0Ka_p0tdwvSSn-2TAECrgXFCrs5ECQ';
BEGIN
  SELECT spesa_firecrawl_usd, status
    INTO v_spent, v_status
    FROM public.padova_firecrawl_jobs
   WHERE job_id = v_job_id;

  SELECT count(*) INTO v_remaining
    FROM public.padova_collect_v2_items
   WHERE job_id = 'e9709a73-e91f-49c4-bc11-a8bf27829875'
     AND mq IS NULL AND raw_json IS NULL AND url IS NOT NULL;

  IF v_remaining = 0 OR COALESCE(v_spent,0) >= v_spend_cap OR v_status IN ('done','stopped_spend_cap') THEN
    IF v_remaining = 0 THEN
      UPDATE public.padova_firecrawl_jobs
         SET status='done', finished_at=now(), updated_at=now()
       WHERE job_id = v_job_id AND status <> 'done';
    END IF;
    -- FIX: wrap unschedule of legacy job that may not exist anymore.
    BEGIN
      PERFORM cron.unschedule('padova-firecrawl-auto-collect');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RETURN;
  END IF;

  v_url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/padova-firecrawl-detail-collect';

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey', v_anon,
      'Authorization', 'Bearer ' || v_anon
    ),
    body := jsonb_build_object(
      'action','run_batch',
      'job_id', v_job_id,
      'n', 600,
      'spend_cap_usd', v_spend_cap
    ),
    timeout_milliseconds := 30000
  );
END $function$;
