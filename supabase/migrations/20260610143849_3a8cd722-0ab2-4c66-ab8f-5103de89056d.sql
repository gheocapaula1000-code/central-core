CREATE TABLE IF NOT EXISTS public.padova_subito_staging (id BIGSERIAL PRIMARY KEY, raw_json JSONB, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.padova_subito_staging TO authenticated;
GRANT ALL ON public.padova_subito_staging TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.padova_subito_staging_id_seq TO authenticated, service_role;
ALTER TABLE public.padova_subito_staging ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_all_subito_staging" ON public.padova_subito_staging FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));