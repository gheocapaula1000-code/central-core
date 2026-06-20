CREATE UNIQUE INDEX IF NOT EXISTS padova_listings_fonte_url_uniq
  ON public.padova_listings (fonte, url)
  WHERE url IS NOT NULL;