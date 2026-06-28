CREATE TABLE IF NOT EXISTS public.test_casa_parsed_listings (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL,
  page_index INTEGER NOT NULL,
  listing_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  title TEXT,
  zone TEXT,
  price_eur INTEGER,
  surface_sqm INTEGER,
  rooms INTEGER,
  bathrooms INTEGER,
  floor TEXT,
  energy_class TEXT,
  description TEXT,
  agency_name TEXT,
  agency_slug TEXT,
  agency_url TEXT,
  is_privato BOOLEAN NOT NULL DEFAULT false,
  badge TEXT,
  tier TEXT,
  raw_block TEXT,
  parser_version TEXT NOT NULL DEFAULT 'v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT test_casa_parsed_listings_job_listing_unique UNIQUE (job_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_test_casa_parsed_job ON public.test_casa_parsed_listings(job_id);
CREATE INDEX IF NOT EXISTS idx_test_casa_parsed_agency_slug ON public.test_casa_parsed_listings(agency_slug);

GRANT ALL ON public.test_casa_parsed_listings TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.test_casa_parsed_listings_id_seq TO service_role;

ALTER TABLE public.test_casa_parsed_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access test_casa_parsed_listings"
  ON public.test_casa_parsed_listings
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.tg_test_casa_parsed_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_test_casa_parsed_updated
  BEFORE UPDATE ON public.test_casa_parsed_listings
  FOR EACH ROW EXECUTE FUNCTION public.tg_test_casa_parsed_set_updated_at();