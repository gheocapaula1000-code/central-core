CREATE INDEX IF NOT EXISTS padova_listings_ev_canonical_idx
  ON public.padova_listings (ev_canonical_listing_id)
  WHERE expired_at IS NULL;

CREATE INDEX IF NOT EXISTS padova_listings_recompute_scope_idx
  ON public.padova_listings (commercial_zone_slug, ev_agency_key)
  WHERE expired_at IS NULL;

CREATE INDEX IF NOT EXISTS padova_listings_ev_flags_todo_idx
  ON public.padova_listings (id)
  WHERE ev_flags_at IS NULL;

ANALYZE public.padova_listings;