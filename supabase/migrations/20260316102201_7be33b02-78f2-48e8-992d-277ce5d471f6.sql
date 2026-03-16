
CREATE TABLE public.omi_import_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  storage_path text NOT NULL,
  semestre text NOT NULL DEFAULT '2025/1',
  status text NOT NULL DEFAULT 'pending',
  current_offset integer NOT NULL DEFAULT 0,
  batch_size integer NOT NULL DEFAULT 300,
  total_files_seen integer NOT NULL DEFAULT 0,
  total_files_processed integer NOT NULL DEFAULT 0,
  total_geometries_imported integer NOT NULL DEFAULT 0,
  total_errors integer NOT NULL DEFAULT 0,
  has_more boolean NOT NULL DEFAULT true,
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  clear_first boolean NOT NULL DEFAULT false,
  comune_istat_fallback text DEFAULT '',
  UNIQUE (storage_path, semestre)
);

ALTER TABLE public.omi_import_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_omi_import_jobs" ON public.omi_import_jobs
  FOR SELECT TO public USING (true);
