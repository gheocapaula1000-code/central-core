DO $$
DECLARE r jsonb;
BEGIN
  r := public.recompute_padova_listings_contendibili();
  RAISE NOTICE 'recompute: %', r;
END $$;