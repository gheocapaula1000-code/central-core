-- Live Core jpunnzgixcghuydstdlt only.
-- Re-schedule Bakeca scrape, Firecrawl detail collect, and off-market Padova nightly
-- through the wrappers that send x-job-secret via log_cron_http_invocation.
-- No hardcoded JWT / secrets.

CREATE OR REPLACE FUNCTION public.claim_padova_detail_batch(p_size int DEFAULT 8)
RETURNS TABLE(id bigint, url text, attempts int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
    WITH picked AS (
      SELECT i.id
      FROM public.padova_collect_v2_items i
      WHERE i.url IS NOT NULL
        AND i.job_id = 'e9709a73-e91f-49c4-bc11-a8bf27829875'
        AND i.attempts < 2
        AND (i.processed_at IS NULL OR i.parse_status IN ('failed_processed_unknown','error'))
      ORDER BY i.id
      LIMIT p_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.padova_collect_v2_items t
    SET attempts = COALESCE(t.attempts, 0) + 1
    FROM picked p
    WHERE t.id = p.id
    RETURNING t.id, t.url, t.attempts;
END;
$$;

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
  v_url text := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/padova-firecrawl-detail-collect';
  v_secret text;
BEGIN
  SELECT spesa_firecrawl_usd, status
    INTO v_spent, v_status
    FROM public.padova_firecrawl_jobs
   WHERE job_id = v_job_id;

  SELECT count(*) INTO v_remaining
    FROM public.padova_collect_v2_items
   WHERE job_id = 'e9709a73-e91f-49c4-bc11-a8bf27829875'
     AND url IS NOT NULL
     AND attempts < 2
     AND (processed_at IS NULL OR parse_status IN ('failed_processed_unknown','error'));

  IF v_remaining = 0 OR COALESCE(v_spent,0) >= v_spend_cap OR v_status IN ('done','stopped_spend_cap') THEN
    IF v_remaining = 0 THEN
      UPDATE public.padova_firecrawl_jobs
         SET status='done', finished_at=now(), updated_at=now()
       WHERE job_id = v_job_id AND status <> 'done';
    END IF;
    BEGIN
      PERFORM cron.unschedule('padova-firecrawl-auto-collect');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
   WHERE name = 'CENTRAL_CORE_JOB_SECRET'
   LIMIT 1;

  IF v_secret IS NULL OR length(v_secret) = 0 THEN
    RAISE EXCEPTION 'job secret not configured';
  END IF;

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-job-secret', v_secret
    ),
    body := jsonb_build_object(
      'action','run_one_batch',
      'job_id', v_job_id
    ),
    timeout_milliseconds := 90000
  );
END
$function$;

DO $$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'offmarket-chain-1-radar',
    'offmarket-chain-2-earlywarning',
    'offmarket-chain-3-discover',
    'offmarket-chain-4-padova',
    'offmarket-chain-5-scores',
    'padova-firecrawl-auto-collect',
    'civiko-bakeca-scrape',
    'padova-firecrawl-detail-collect',
    'central-core-offmarket-padova-nightly',
    'central-core-early-offmarket-nightly',
    'central-core-offmarket-scores-nightly',
    'central-core-padova-early-warning-nightly'
  ] LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
        PERFORM cron.unschedule(j);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

-- Bakeca private listings — 02:35 UTC, after Subito private-leads nightly.
SELECT cron.schedule(
  'civiko-bakeca-scrape',
  '35 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'civiko-bakeca-scrape',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-bakeca-scrape',
      '{"trigger":"cron"}'::jsonb
    );
  $cmd$
);

-- Firecrawl detail collect — every 15 minutes, one claimed batch.
SELECT cron.schedule(
  'padova-firecrawl-detail-collect',
  '*/15 * * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'padova-firecrawl-detail-collect',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/padova-firecrawl-detail-collect',
      '{"action":"run_one_batch"}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'central-core-offmarket-padova-nightly',
  '30 3 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'central-core-offmarket-padova-nightly',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-offmarket-padova-nightly?job=offmarket-padova',
      '{}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'central-core-early-offmarket-nightly',
  '45 3 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'central-core-early-offmarket-nightly',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-offmarket-padova-nightly?job=discover-early-offmarket-signals',
      '{}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'central-core-offmarket-scores-nightly',
  '0 4 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'central-core-offmarket-scores-nightly',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-offmarket-padova-nightly?job=build-offmarket-opportunity-scores',
      '{}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'central-core-padova-early-warning-nightly',
  '10 4 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'central-core-padova-early-warning-nightly',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-offmarket-padova-nightly?job=build-padova-early-warning',
      '{}'::jsonb
    );
  $cmd$
);
