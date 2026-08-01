DO $$
DECLARE r jsonb;
BEGIN
  r := public.recompute_padova_listings_contendibili();
  RAISE NOTICE 'RECOMPUTE: %', r::text;
  CREATE TABLE IF NOT EXISTS public.padova_recompute_last_result (
    id int PRIMARY KEY DEFAULT 1,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  INSERT INTO public.padova_recompute_last_result (id, result, created_at)
  VALUES (1, r, now())
  ON CONFLICT (id) DO UPDATE SET result = EXCLUDED.result, created_at = now();
END $$;

GRANT ALL ON public.padova_recompute_last_result TO service_role;
ALTER TABLE public.padova_recompute_last_result ENABLE ROW LEVEL SECURITY;