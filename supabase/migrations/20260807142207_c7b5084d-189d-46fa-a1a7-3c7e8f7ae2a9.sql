CREATE TABLE IF NOT EXISTS public.trovabandi_source_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES public.trovabandi_sources(id) ON DELETE CASCADE,
  url text NOT NULL,
  url_hash text NOT NULL,
  title text,
  snippet text,
  provider text,
  content_hash text,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trovabandi_source_candidates_uniq UNIQUE (source_id, url_hash)
);

GRANT ALL ON public.trovabandi_source_candidates TO service_role;

ALTER TABLE public.trovabandi_source_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trovabandi_source_candidates_service_role_only" ON public.trovabandi_source_candidates;
CREATE POLICY "trovabandi_source_candidates_service_role_only"
ON public.trovabandi_source_candidates
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE INDEX IF NOT EXISTS trovabandi_source_candidates_rotation_idx
  ON public.trovabandi_source_candidates (source_id, last_attempted_at NULLS FIRST, attempt_count, url);

CREATE INDEX IF NOT EXISTS trovabandi_source_candidates_fresh_idx
  ON public.trovabandi_source_candidates (source_id, last_seen_at DESC);

CREATE OR REPLACE FUNCTION public.trovabandi_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trovabandi_source_candidates_touch ON public.trovabandi_source_candidates;
CREATE TRIGGER trovabandi_source_candidates_touch
BEFORE UPDATE ON public.trovabandi_source_candidates
FOR EACH ROW EXECUTE FUNCTION public.trovabandi_touch_updated_at();