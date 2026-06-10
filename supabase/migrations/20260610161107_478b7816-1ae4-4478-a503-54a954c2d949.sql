CREATE TABLE IF NOT EXISTS public.padova_immobiliare_detail_staging (
  id bigserial PRIMARY KEY,
  run_id text,
  url text,
  agency text,
  tipo_lead text,
  mq numeric,
  locali numeric,
  bagni numeric,
  prezzo numeric,
  lat double precision,
  lng double precision,
  indirizzo text,
  raw_json jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.padova_immobiliare_detail_staging TO service_role;
GRANT SELECT ON public.padova_immobiliare_detail_staging TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.padova_immobiliare_detail_staging_id_seq TO service_role;
ALTER TABLE public.padova_immobiliare_detail_staging ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read staging immobiliare detail" ON public.padova_immobiliare_detail_staging
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE INDEX IF NOT EXISTS idx_pids_url ON public.padova_immobiliare_detail_staging(url);