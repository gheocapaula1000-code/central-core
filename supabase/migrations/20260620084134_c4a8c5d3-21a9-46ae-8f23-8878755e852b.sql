DROP INDEX IF EXISTS public.padova_listings_fonte_url_uniq;
ALTER TABLE public.padova_listings
  ADD CONSTRAINT padova_listings_fonte_url_uniq UNIQUE (fonte, url);