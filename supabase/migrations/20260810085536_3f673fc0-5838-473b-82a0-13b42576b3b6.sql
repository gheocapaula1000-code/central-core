ALTER TABLE public.padova_listings
  ADD COLUMN IF NOT EXISTS ev_tipologia            text,
  ADD COLUMN IF NOT EXISTS ev_canonical_listing_id text,
  ADD COLUMN IF NOT EXISTS ev_is_asta              boolean,
  ADD COLUMN IF NOT EXISTS ev_is_mls               boolean,
  ADD COLUMN IF NOT EXISTS ev_agency_key           text,
  ADD COLUMN IF NOT EXISTS ev_flags_at             timestamptz;

CREATE OR REPLACE FUNCTION public.padova_listings_ev_flags_trg()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.raw_json IS NOT DISTINCT FROM OLD.raw_json
     AND NEW.url      IS NOT DISTINCT FROM OLD.url
     AND NEW.fonte    IS NOT DISTINCT FROM OLD.fonte
     AND NEW.agency   IS NOT DISTINCT FROM OLD.agency
     AND OLD.ev_flags_at IS NOT NULL
  THEN
    RETURN NEW;
  END IF;

  NEW.ev_tipologia            := public.padova_unit_tipologia(NEW.raw_json);
  NEW.ev_canonical_listing_id := public.padova_listing_canonical_id(NEW.url, NEW.fonte);
  NEW.ev_is_asta              := public.padova_listing_has_auction_evidence(NEW.raw_json, NEW.agency);
  NEW.ev_is_mls               := public.padova_listing_has_mls_exclusive_evidence(NEW.raw_json);
  NEW.ev_agency_key           := COALESCE(
      NULLIF(public.norm_agency(regexp_replace(lower(trim(NEW.agency)),
             '^(agenzia immobiliare|immobiliare)\s+', '', 'g')), ''),
      public.norm_agency(NEW.agency));
  NEW.ev_flags_at             := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS padova_listings_ev_flags_trg ON public.padova_listings;
CREATE TRIGGER padova_listings_ev_flags_trg
BEFORE INSERT OR UPDATE OF raw_json, url, fonte, agency
ON public.padova_listings
FOR EACH ROW EXECUTE FUNCTION public.padova_listings_ev_flags_trg();