DO $$
DECLARE r jsonb; r2 jsonb;
BEGIN
  SELECT public.promote_padova_collect_v2_to_listings('2026-08-04 07:02:00+00'::timestamptz) INTO r;
  RAISE NOTICE 'promote=%', r;
  BEGIN
    SELECT public.recompute_padova_listings_contendibili() INTO r2;
    RAISE NOTICE 'recompute=%', r2;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'recompute_error=%', SQLERRM;
  END;
END $$;