CREATE OR REPLACE FUNCTION public.unschedule_padova_detail_chain()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'cron'
AS $$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'padova_detail_chain') INTO v_exists;
  IF v_exists THEN
    PERFORM cron.unschedule('padova_detail_chain');
    RETURN true;
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.unschedule_padova_detail_chain() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unschedule_padova_detail_chain() TO service_role;