
CREATE TABLE IF NOT EXISTS public.test_casa_raw_pages (
  job_id uuid NOT NULL,
  crawl_id text NOT NULL,
  page_index integer NOT NULL,
  url text,
  markdown text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, page_index)
);
CREATE INDEX IF NOT EXISTS test_casa_raw_pages_crawl_idx ON public.test_casa_raw_pages (crawl_id);
GRANT ALL ON public.test_casa_raw_pages TO service_role;
ALTER TABLE public.test_casa_raw_pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role manages casa raw pages" ON public.test_casa_raw_pages
  FOR ALL TO service_role USING (true) WITH CHECK (true);
