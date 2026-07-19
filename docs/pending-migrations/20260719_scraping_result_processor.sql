-- ============================================================================
-- scraping_queue: livello separato di RESULT PROCESSING
-- Non applicare automaticamente. Revisione richiesta prima dell'esecuzione.
-- Prerequisito: creare vault.secrets 'scraping_result_processor_url'
--   (valore atteso: https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/scraping-result-processor)
-- e 'scraping_worker_token'.
-- ============================================================================

BEGIN;

-- 1) Colonne nuove su public.scraping_queue --------------------------------------

ALTER TABLE public.scraping_queue
  ADD COLUMN IF NOT EXISTS processor                 text,
  ADD COLUMN IF NOT EXISTS processor_context         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS processing_status         text        NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS processing_attempt        integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_max_attempts   integer     NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS processing_available_at   timestamptz,
  ADD COLUMN IF NOT EXISTS processing_locked_at      timestamptz,
  ADD COLUMN IF NOT EXISTS processing_locked_until   timestamptz,
  ADD COLUMN IF NOT EXISTS processing_locked_by      uuid,
  ADD COLUMN IF NOT EXISTS processing_last_error     jsonb,
  ADD COLUMN IF NOT EXISTS processed_at              timestamptz;

ALTER TABLE public.scraping_queue
  DROP CONSTRAINT IF EXISTS scraping_queue_processing_status_chk;
ALTER TABLE public.scraping_queue
  ADD CONSTRAINT scraping_queue_processing_status_chk
  CHECK (processing_status IN ('not_required','pending','running','retry','succeeded','dead'));

ALTER TABLE public.scraping_queue
  DROP CONSTRAINT IF EXISTS scraping_queue_processor_status_coherence_chk;
ALTER TABLE public.scraping_queue
  ADD CONSTRAINT scraping_queue_processor_status_coherence_chk
  CHECK (
    (processor IS NULL     AND processing_status = 'not_required')
    OR
    (processor IS NOT NULL AND processing_status IN ('pending','running','retry','succeeded','dead'))
  );

-- Constraint idempotenti aggiuntivi
ALTER TABLE public.scraping_queue
  DROP CONSTRAINT IF EXISTS scraping_queue_processing_attempt_chk;
ALTER TABLE public.scraping_queue
  ADD CONSTRAINT scraping_queue_processing_attempt_chk
  CHECK (processing_attempt >= 0);

ALTER TABLE public.scraping_queue
  DROP CONSTRAINT IF EXISTS scraping_queue_processing_max_attempts_chk;
ALTER TABLE public.scraping_queue
  ADD CONSTRAINT scraping_queue_processing_max_attempts_chk
  CHECK (processing_max_attempts BETWEEN 1 AND 20);

ALTER TABLE public.scraping_queue
  DROP CONSTRAINT IF EXISTS scraping_queue_processor_nonblank_chk;
ALTER TABLE public.scraping_queue
  ADD CONSTRAINT scraping_queue_processor_nonblank_chk
  CHECK (processor IS NULL OR btrim(processor) <> '');

ALTER TABLE public.scraping_queue
  DROP CONSTRAINT IF EXISTS scraping_queue_processor_context_object_chk;
ALTER TABLE public.scraping_queue
  ADD CONSTRAINT scraping_queue_processor_context_object_chk
  CHECK (jsonb_typeof(processor_context) = 'object');

CREATE OR REPLACE FUNCTION public.scraping_queue_processor_normalize()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $$
BEGIN
  IF NEW.processor IS NULL THEN
    NEW.processing_status := 'not_required';
    NEW.processing_available_at := NULL;
  ELSE
    IF TG_OP = 'INSERT' OR (OLD.processor IS DISTINCT FROM NEW.processor) THEN
      NEW.processing_status := COALESCE(NULLIF(NEW.processing_status,'not_required'), 'pending');
      IF NEW.processing_status = 'pending' AND NEW.processing_available_at IS NULL THEN
        NEW.processing_available_at := now();
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_scraping_queue_processor_normalize ON public.scraping_queue;
CREATE TRIGGER trg_scraping_queue_processor_normalize
BEFORE INSERT OR UPDATE OF processor ON public.scraping_queue
FOR EACH ROW EXECUTE FUNCTION public.scraping_queue_processor_normalize();

UPDATE public.scraping_queue
   SET processing_status = 'not_required'
 WHERE processor IS NULL
   AND processing_status <> 'not_required';

CREATE INDEX IF NOT EXISTS scraping_queue_processing_claim_idx
  ON public.scraping_queue (priority DESC, processing_available_at, created_at)
  WHERE status = 'succeeded'
    AND processor IS NOT NULL
    AND processing_status IN ('pending','retry');

CREATE INDEX IF NOT EXISTS scraping_queue_processing_lease_idx
  ON public.scraping_queue (processing_locked_until)
  WHERE processing_status = 'running';

-- ============================================================================
-- 2) RPC SECURITY DEFINER (solo service_role / postgres)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.scraping_enqueue_processed(
  p_provider           scraping_provider,
  p_operation          text,
  p_payload            jsonb,
  p_processor          text,
  p_processor_context  jsonb   DEFAULT '{}'::jsonb,
  p_idempotency_key    text    DEFAULT NULL,
  p_group_key          text    DEFAULT NULL,
  p_priority           smallint DEFAULT 100,
  p_max_attempts       integer DEFAULT 5,
  p_timeout_seconds    integer DEFAULT 30,
  p_available_at       timestamptz DEFAULT now(),
  p_parent_id          uuid    DEFAULT NULL,
  p_depends_on         uuid[]  DEFAULT '{}'::uuid[],
  p_processing_max_attempts integer DEFAULT 5
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
DECLARE
  v_id uuid;
  v_timeout integer;
  v_priority smallint;
  v_max_attempts integer;
  v_proc_max integer;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_processor IS NULL OR btrim(p_processor) = '' THEN
    RAISE EXCEPTION 'processor required';
  END IF;
  IF p_processor_context IS NOT NULL
     AND jsonb_typeof(p_processor_context) <> 'object' THEN
    RAISE EXCEPTION 'processor_context must be a JSON object';
  END IF;

  -- Normalizzazione entro i vincoli della tabella
  v_timeout := least(greatest(coalesce(p_timeout_seconds, 30), 5), 120);
  v_priority := least(greatest(coalesce(p_priority, 100)::integer, 0), 1000)::smallint;
  v_max_attempts := least(greatest(coalesce(p_max_attempts, 5), 1), 20);
  v_proc_max := least(greatest(coalesce(p_processing_max_attempts, 5), 1), 20);

  INSERT INTO public.scraping_queue(
    provider, operation, payload, idempotency_key, group_key, priority,
    max_attempts, timeout_seconds, available_at, parent_id, depends_on,
    processor, processor_context, processing_max_attempts
  ) VALUES (
    p_provider, btrim(p_operation), coalesce(p_payload,'{}'::jsonb),
    nullif(btrim(p_idempotency_key),''), nullif(btrim(p_group_key),''),
    v_priority, v_max_attempts, v_timeout, p_available_at,
    p_parent_id, coalesce(p_depends_on,'{}'::uuid[]),
    btrim(p_processor), coalesce(p_processor_context,'{}'::jsonb),
    v_proc_max
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
    AND status IN ('pending','running','retry','succeeded')
  DO UPDATE SET updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.scraping_processing_claim(
  p_worker_id      uuid,
  p_limit          integer DEFAULT 5,
  p_lease_seconds  integer DEFAULT 90
) RETURNS TABLE(
  id uuid,
  provider scraping_provider,
  operation text,
  payload jsonb,
  result jsonb,
  result_ref text,
  processor text,
  processor_context jsonb,
  processing_attempt integer,
  processing_max_attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT q.id
      FROM public.scraping_queue q
     WHERE q.status = 'succeeded'
       AND q.processor IS NOT NULL
       AND q.processing_status IN ('pending','retry')
       AND coalesce(q.processing_available_at, q.completed_at, q.updated_at, now()) <= now()
     ORDER BY q.priority DESC, coalesce(q.processing_available_at, now()), q.created_at
     FOR UPDATE OF q SKIP LOCKED
     LIMIT least(greatest(p_limit,1), 20)
  ), claimed AS (
    UPDATE public.scraping_queue q
       SET processing_status      = 'running',
           processing_attempt     = q.processing_attempt + 1,
           processing_locked_at   = now(),
           processing_locked_until= now() + make_interval(secs => least(greatest(p_lease_seconds,15), 300)),
           processing_locked_by   = p_worker_id,
           updated_at             = now()
      FROM candidates c
     WHERE q.id = c.id
     RETURNING q.*
  )
  SELECT c.id, c.provider, c.operation, c.payload, c.result, c.result_ref,
         c.processor, c.processor_context, c.processing_attempt, c.processing_max_attempts
    FROM claimed c;
END $$;

CREATE OR REPLACE FUNCTION public.scraping_processing_complete(
  p_id        uuid,
  p_worker_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
DECLARE v_attempt integer;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  UPDATE public.scraping_queue
     SET processing_status      = 'succeeded',
         processing_locked_at   = NULL,
         processing_locked_until= NULL,
         processing_locked_by   = NULL,
         processing_last_error  = NULL,
         processed_at           = now(),
         updated_at             = now()
   WHERE id = p_id
     AND processing_status = 'running'
     AND processing_locked_by = p_worker_id
     AND processing_locked_until > now()
   RETURNING processing_attempt INTO v_attempt;

  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO public.scraping_queue_events(queue_id,event,attempt,worker_id,detail)
  VALUES (p_id,'processing_succeeded',v_attempt,p_worker_id,'{}'::jsonb);
  RETURN true;
END $$;

-- fail: NON tocca status='succeeded' del provider, non ripete chiamate esterne
CREATE OR REPLACE FUNCTION public.scraping_processing_fail(
  p_id        uuid,
  p_worker_id uuid,
  p_error     jsonb,
  p_retryable boolean DEFAULT true
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
DECLARE
  v_attempt integer; v_max integer; v_next text; v_delay integer;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  SELECT processing_attempt, processing_max_attempts
    INTO v_attempt, v_max
    FROM public.scraping_queue
   WHERE id = p_id
     AND processing_status = 'running'
     AND processing_locked_by = p_worker_id
     AND processing_locked_until > now()
   FOR UPDATE;

  IF NOT FOUND THEN RETURN 'lost_lease'; END IF;

  v_next  := CASE WHEN p_retryable AND v_attempt < v_max THEN 'retry' ELSE 'dead' END;
  v_delay := least(3600, (15 * power(2, least(v_attempt - 1, 7)))::integer + floor(random() * 16)::integer);

  UPDATE public.scraping_queue
     SET processing_status      = v_next,
         processing_last_error  = coalesce(p_error,'{}'::jsonb),
         processing_available_at= CASE WHEN v_next = 'retry'
                                       THEN now() + make_interval(secs => greatest(v_delay,1))
                                       ELSE processing_available_at END,
         processed_at           = CASE WHEN v_next = 'dead' THEN now() ELSE processed_at END,
         processing_locked_at   = NULL,
         processing_locked_until= NULL,
         processing_locked_by   = NULL,
         updated_at             = now()
   WHERE id = p_id;

  INSERT INTO public.scraping_queue_events(queue_id,event,attempt,worker_id,detail)
  VALUES (p_id, 'processing_'||v_next, v_attempt, p_worker_id,
          jsonb_build_object('error', p_error,
                             'retry_after_seconds', CASE WHEN v_next='retry' THEN v_delay ELSE NULL END));
  RETURN v_next;
END $$;

CREATE OR REPLACE FUNCTION public.scraping_processing_reap_expired()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
DECLARE v_count integer;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  WITH expired AS (
    UPDATE public.scraping_queue
       SET processing_status = CASE WHEN processing_attempt < processing_max_attempts
                                    THEN 'retry' ELSE 'dead' END,
           processing_available_at = CASE
                                       WHEN processing_attempt < processing_max_attempts
                                         THEN now() + interval '30 seconds'
                                       ELSE NULL
                                     END,
           processed_at = CASE WHEN processing_attempt >= processing_max_attempts THEN now() ELSE processed_at END,
           processing_last_error = jsonb_build_object('code','processing_lease_expired',
                                                     'message','Processor worker stopped or timed out'),
           processing_locked_at = NULL,
           processing_locked_until = NULL,
           processing_locked_by = NULL,
           updated_at = now()
     WHERE processing_status = 'running'
       AND processing_locked_until < now()
     RETURNING id, processing_attempt, processing_status
  )
  INSERT INTO public.scraping_queue_events(queue_id,event,attempt,detail)
  SELECT id, 'processing_'||processing_status, processing_attempt,
         jsonb_build_object('reason','processing_lease_expired')
    FROM expired;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- Permessi: solo service_role
REVOKE ALL ON FUNCTION public.scraping_enqueue_processed(scraping_provider,text,jsonb,text,jsonb,text,text,smallint,integer,integer,timestamptz,uuid,uuid[],integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scraping_processing_claim(uuid,integer,integer)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scraping_processing_complete(uuid,uuid)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scraping_processing_fail(uuid,uuid,jsonb,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scraping_processing_reap_expired()                FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.scraping_enqueue_processed(scraping_provider,text,jsonb,text,jsonb,text,text,smallint,integer,integer,timestamptz,uuid,uuid[],integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.scraping_processing_claim(uuid,integer,integer)   TO service_role;
GRANT EXECUTE ON FUNCTION public.scraping_processing_complete(uuid,uuid)           TO service_role;
GRANT EXECUTE ON FUNCTION public.scraping_processing_fail(uuid,uuid,jsonb,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.scraping_processing_reap_expired()                TO service_role;

-- ============================================================================
-- 3) Cron pg_net (URL e token dal Vault). Nessuna richiesta se manca un secret.
-- ============================================================================

DO $cron$
DECLARE v_existing integer;
BEGIN
  SELECT jobid INTO v_existing FROM cron.job WHERE jobname = 'scraping-result-processor-dispatch';
  IF v_existing IS NOT NULL THEN PERFORM cron.unschedule(v_existing); END IF;

  SELECT jobid INTO v_existing FROM cron.job WHERE jobname = 'scraping-result-processor-reaper';
  IF v_existing IS NOT NULL THEN PERFORM cron.unschedule(v_existing); END IF;
END $cron$;

SELECT cron.schedule(
  'scraping-result-processor-dispatch',
  '* * * * *',
  $$
  DO $body$
  DECLARE
    v_url   text;
    v_token text;
  BEGIN
    SELECT decrypted_secret INTO v_url
      FROM vault.decrypted_secrets
     WHERE name = 'scraping_result_processor_url'
     LIMIT 1;

    SELECT decrypted_secret INTO v_token
      FROM vault.decrypted_secrets
     WHERE name = 'scraping_worker_token'
     LIMIT 1;

    IF v_url IS NULL OR btrim(v_url) = ''
       OR v_token IS NULL OR btrim(v_token) = '' THEN
      RAISE NOTICE 'scraping-result-processor-dispatch skipped: missing vault secrets';
      RETURN;
    END IF;

    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-worker-token', v_token
      ),
      body := jsonb_build_object('limit', 3, 'concurrency', 3),
      timeout_milliseconds := 25000
    );
  END
  $body$;
  $$
);

SELECT cron.schedule(
  'scraping-result-processor-reaper',
  '*/2 * * * *',
  $$ SELECT public.scraping_processing_reap_expired(); $$
);

COMMIT;
