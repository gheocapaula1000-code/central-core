DO $$
DECLARE
  qa_ws uuid[] := ARRAY['7d644334-9396-4ec7-9d32-2b08df64601c','25fb326d-17f4-4f50-8352-16baab6b4b02']::uuid[];
  qa_users uuid[] := ARRAY['fac2881a-a970-4827-afe4-580d191b1e6f','e347cba0-680a-4776-a5d1-13b6f2081d07']::uuid[];
  v_owner uuid;
  v_n integer;
BEGIN
  SELECT trial_agency_id INTO v_owner FROM public.civiko_commercial_zones WHERE slug = 'centro-storico';
  IF v_owner IS NOT NULL AND NOT (v_owner = ANY(qa_ws)) THEN
    RAISE EXCEPTION 'ABORT: trial owner % non e una identita QA', v_owner;
  END IF;

  UPDATE public.civiko_commercial_zones
     SET status = 'disponibile', trial_agency_id = NULL, trial_reserved_until = NULL
   WHERE slug = 'centro-storico' AND trial_agency_id = ANY(qa_ws);

  DELETE FROM public.agency_memberships
   WHERE agency_id = ANY(qa_ws) AND user_id = ANY(qa_users);

  DELETE FROM public.agencies
   WHERE id = ANY(qa_ws) AND billing_email LIKE 'qa-territory-%@civiko.invalid';

  SELECT count(*) INTO v_n FROM public.civiko_commercial_zones WHERE status <> 'disponibile';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'ABORT: % zone non disponibili dopo cleanup', v_n;
  END IF;
END $$;