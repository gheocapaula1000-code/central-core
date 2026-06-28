CREATE OR REPLACE FUNCTION public.recompute_padova_contendibili()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_r1 jsonb;
  v_r2 jsonb;
BEGIN
  v_r1 := public.recompute_padova_listings_contendibili();
  v_r2 := public.recompute_padova_contendibili_extras();
  RETURN jsonb_build_object(
    'ok', true,
    'clustering', v_r1,
    'extras', v_r2
  );
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_padova_contendibili() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recompute_padova_contendibili() TO service_role;