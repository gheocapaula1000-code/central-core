CREATE TABLE IF NOT EXISTS public.veneto_comuni (
  codice_istat TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  nome_normalizzato TEXT NOT NULL,
  provincia TEXT NOT NULL,
  provincia_nome TEXT NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  popolazione INTEGER,
  is_capoluogo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vc_provincia ON public.veneto_comuni(provincia);
CREATE INDEX IF NOT EXISTS idx_vc_nome_norm ON public.veneto_comuni(nome_normalizzato);
CREATE INDEX IF NOT EXISTS idx_vc_nome ON public.veneto_comuni(nome);

ALTER TABLE public.veneto_comuni ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_vc" ON public.veneto_comuni FOR SELECT USING (true);
CREATE POLICY "service_role_full_vc" ON public.veneto_comuni FOR ALL TO service_role USING (true) WITH CHECK (true);