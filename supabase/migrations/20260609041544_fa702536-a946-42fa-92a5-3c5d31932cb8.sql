CREATE TABLE public.padova_collect_v2_items (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL,
  portal TEXT NOT NULL,
  listing_id TEXT,
  url TEXT,
  raw_address TEXT,
  citta TEXT,
  cap TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  omi_zone TEXT,
  quartiere TEXT,
  tipo_lead TEXT,
  n_agenzie INTEGER,
  prezzo NUMERIC,
  prezzo_iniziale NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_padova_collect_v2_items_job ON public.padova_collect_v2_items(job_id);
CREATE INDEX idx_padova_collect_v2_items_omi ON public.padova_collect_v2_items(omi_zone);

GRANT ALL ON public.padova_collect_v2_items TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.padova_collect_v2_items_id_seq TO service_role;

ALTER TABLE public.padova_collect_v2_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access padova_collect_v2_items"
ON public.padova_collect_v2_items
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);