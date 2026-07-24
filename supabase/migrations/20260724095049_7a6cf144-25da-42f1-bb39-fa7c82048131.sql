
CREATE INDEX IF NOT EXISTS padova_listings_zone_active_idx
  ON public.padova_listings (commercial_zone_slug)
  WHERE expired_at IS NULL AND lower(comune) = 'padova';

CREATE INDEX IF NOT EXISTS padova_listings_zone_quartiere_active_idx
  ON public.padova_listings (commercial_zone_slug, quartiere)
  WHERE expired_at IS NULL AND lower(comune) = 'padova';

ANALYZE public.padova_listings;
ANALYZE public.padova_listings_price_history;
