
CREATE TABLE IF NOT EXISTS public.test_listing_first_seen (
  url TEXT PRIMARY KEY,
  portal TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.test_listing_first_seen TO service_role;
ALTER TABLE public.test_listing_first_seen ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role full access test_listing_first_seen"
  ON public.test_listing_first_seen FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
