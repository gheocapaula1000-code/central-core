
CREATE TABLE public.listing_agency_enrichment (
  id BIGSERIAL PRIMARY KEY,
  listing_url TEXT NOT NULL,
  portal TEXT NOT NULL,
  raw_agency_name TEXT,
  normalized_agency_name TEXT,
  agency_url TEXT,
  agency_phone TEXT,
  agency_logo_url TEXT,
  extraction_method TEXT,
  confidence TEXT,
  enriched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error TEXT,
  raw_excerpt JSONB,
  CONSTRAINT listing_agency_enrichment_url_uq UNIQUE (listing_url)
);

CREATE INDEX listing_agency_enrichment_portal_idx ON public.listing_agency_enrichment(portal);
CREATE INDEX listing_agency_enrichment_enriched_at_idx ON public.listing_agency_enrichment(enriched_at DESC);
CREATE INDEX listing_agency_enrichment_normalized_idx ON public.listing_agency_enrichment(normalized_agency_name) WHERE normalized_agency_name IS NOT NULL;

GRANT SELECT ON public.listing_agency_enrichment TO authenticated;
GRANT ALL ON public.listing_agency_enrichment TO service_role;

ALTER TABLE public.listing_agency_enrichment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access" ON public.listing_agency_enrichment
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read" ON public.listing_agency_enrichment
  FOR SELECT TO authenticated USING (true);
