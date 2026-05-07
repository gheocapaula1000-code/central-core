CREATE TABLE IF NOT EXISTS public.sottra_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  address TEXT,
  comune TEXT,
  provincia TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  zona_omi TEXT,
  photo_thumbnail TEXT,
  result_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sottra_scans_user ON public.sottra_scans(user_id);
CREATE INDEX IF NOT EXISTS idx_sottra_scans_comune ON public.sottra_scans(comune);
ALTER TABLE public.sottra_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_own_scans" ON public.sottra_scans FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());