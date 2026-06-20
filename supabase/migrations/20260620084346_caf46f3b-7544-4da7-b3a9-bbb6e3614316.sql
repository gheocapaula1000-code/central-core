CREATE TABLE IF NOT EXISTS public.padova_listings_price_history (
  id            BIGSERIAL PRIMARY KEY,
  listing_id    BIGINT NOT NULL REFERENCES public.padova_listings(id) ON DELETE CASCADE,
  prezzo        INTEGER NOT NULL,
  snapshot_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT padova_listings_price_history_uniq UNIQUE (listing_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS padova_listings_price_history_listing_idx
  ON public.padova_listings_price_history (listing_id, snapshot_date DESC);

GRANT SELECT ON public.padova_listings_price_history TO authenticated;
GRANT ALL    ON public.padova_listings_price_history TO service_role;

ALTER TABLE public.padova_listings_price_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "price_history admin select"
  ON public.padova_listings_price_history
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));