CREATE TABLE public.mim_schools (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codice_meccanografico text NOT NULL,
  denominazione text NOT NULL,
  indirizzo text,
  cap text,
  comune text NOT NULL,
  codice_istat text,
  provincia text NOT NULL,
  regione text,
  grado text NOT NULL, -- 'infanzia', 'primaria', 'secondaria_i', 'secondaria_ii'
  tipologia text, -- e.g. 'statale', 'paritaria'
  lat double precision,
  lng double precision,
  created_at timestamptz DEFAULT now()
);

-- Public read-only access (same as other reference tables)
ALTER TABLE public.mim_schools ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_mim_schools" ON public.mim_schools FOR SELECT TO public USING (true);

-- Performance indexes
CREATE INDEX idx_mim_schools_comune ON public.mim_schools (comune);
CREATE INDEX idx_mim_schools_codice_istat ON public.mim_schools (codice_istat);
CREATE INDEX idx_mim_schools_provincia ON public.mim_schools (provincia);
CREATE INDEX idx_mim_schools_grado ON public.mim_schools (grado);