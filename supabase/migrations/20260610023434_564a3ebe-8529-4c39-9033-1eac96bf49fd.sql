ALTER TABLE public.padova_collect_v2_items ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS public.idx_padova_collect_v2_items_detail_queue;
CREATE INDEX IF NOT EXISTS idx_padova_collect_v2_items_detail_queue
  ON public.padova_collect_v2_items (id)
  WHERE url IS NOT NULL
    AND attempts < 2
    AND (processed_at IS NULL OR parse_status IN ('failed_processed_unknown','error'));