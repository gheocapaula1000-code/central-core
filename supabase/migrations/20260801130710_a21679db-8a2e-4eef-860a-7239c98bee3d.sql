DO $$
DECLARE r jsonb;
BEGIN
  r := public.padova_certify_multi_portale();
  RAISE NOTICE 'certify_multi_portale: %', r;
END $$;