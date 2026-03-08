
CREATE TABLE IF NOT EXISTS public.classificazione_sismica (
  id BIGSERIAL PRIMARY KEY,
  codice_istat TEXT NOT NULL UNIQUE,
  comune TEXT NOT NULL,
  zona_sismica INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sismica_comune ON public.classificazione_sismica(comune);
ALTER TABLE public.classificazione_sismica ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_sismica" ON public.classificazione_sismica FOR SELECT USING (true);
