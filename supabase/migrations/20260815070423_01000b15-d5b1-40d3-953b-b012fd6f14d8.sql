DO $$
DECLARE r jsonb;
BEGIN
  SELECT to_jsonb(public.recompute_padova_listings_contendibili()) INTO r;
  RAISE NOTICE 'recompute %', r;
END $$;