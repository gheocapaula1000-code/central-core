
CREATE TABLE public.omi_import_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  storage_path text NOT NULL,
  file_type text NOT NULL DEFAULT 'unknown',
  semestre text,
  features_read integer NOT NULL DEFAULT 0,
  features_imported integer NOT NULL DEFAULT 0,
  features_skipped integer NOT NULL DEFAULT 0,
  errors jsonb DEFAULT '[]'::jsonb,
  comuni text[] DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','success','partial','failed')),
  smoke_test_passed boolean,
  smoke_test_details jsonb,
  duration_ms integer,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.omi_import_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_omi_import_log" ON public.omi_import_log
  FOR SELECT TO public USING (true);
