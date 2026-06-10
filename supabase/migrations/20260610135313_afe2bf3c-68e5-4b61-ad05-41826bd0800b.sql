
CREATE TABLE IF NOT EXISTS public.padova_casa_staging (
  id bigserial PRIMARY KEY,
  raw_json jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.padova_casa_staging TO service_role;
GRANT SELECT ON public.padova_casa_staging TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.padova_casa_staging_id_seq TO service_role;
ALTER TABLE public.padova_casa_staging ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read padova_casa_staging" ON public.padova_casa_staging
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE TABLE IF NOT EXISTS public.padova_subito_test2 (
  id bigserial PRIMARY KEY,
  raw_json jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.padova_subito_test2 TO service_role;
GRANT SELECT ON public.padova_subito_test2 TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.padova_subito_test2_id_seq TO service_role;
ALTER TABLE public.padova_subito_test2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read padova_subito_test2" ON public.padova_subito_test2
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));
