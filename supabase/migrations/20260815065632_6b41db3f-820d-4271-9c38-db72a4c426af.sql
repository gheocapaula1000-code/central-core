CREATE OR REPLACE FUNCTION public.civiko_admin_invoke_job(p_path text, p_body jsonb DEFAULT '{}'::jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, net, vault
AS $$
DECLARE
  v_secret text;
  v_id bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'CENTRAL_CORE_JOB_SECRET' LIMIT 1;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'job secret missing';
  END IF;
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/' || p_path,
    headers := jsonb_build_object('Content-Type','application/json','x-job-secret', v_secret),
    body := coalesce(p_body, '{}'::jsonb),
    timeout_milliseconds := 120000
  ) INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.civiko_admin_invoke_job(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.civiko_admin_invoke_job(text, jsonb) TO service_role;