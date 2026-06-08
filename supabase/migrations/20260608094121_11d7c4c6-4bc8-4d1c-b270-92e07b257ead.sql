
CREATE TABLE public.test_padova_full_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  state text NOT NULL DEFAULT 'running',
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb
);
GRANT SELECT, INSERT, UPDATE ON public.test_padova_full_run TO authenticated;
GRANT ALL ON public.test_padova_full_run TO service_role;
ALTER TABLE public.test_padova_full_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read test_padova_full_run" ON public.test_padova_full_run FOR SELECT TO authenticated USING (true);
CREATE POLICY "service manages test_padova_full_run" ON public.test_padova_full_run FOR ALL TO service_role USING (true) WITH CHECK (true);
