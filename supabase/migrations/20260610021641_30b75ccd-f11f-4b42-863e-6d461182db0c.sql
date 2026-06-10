ALTER TABLE public.padova_collect_v2_items
  ADD COLUMN IF NOT EXISTS parse_status text,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS http_status integer,
  ADD COLUMN IF NOT EXISTS log_reason text;

CREATE INDEX IF NOT EXISTS idx_padova_collect_v2_items_detail_queue
  ON public.padova_collect_v2_items (job_id, id)
  WHERE processed_at IS NULL OR parse_status IN ('failed_processed_unknown','error');