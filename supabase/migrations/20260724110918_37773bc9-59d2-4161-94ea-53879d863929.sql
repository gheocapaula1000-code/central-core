CREATE TABLE IF NOT EXISTS public._casa_scrape_debug_cache (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  md TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public._casa_scrape_debug_cache TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public._casa_scrape_debug_cache_id_seq TO service_role;
ALTER TABLE public._casa_scrape_debug_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service only" ON public._casa_scrape_debug_cache FOR ALL USING (false) WITH CHECK (false);