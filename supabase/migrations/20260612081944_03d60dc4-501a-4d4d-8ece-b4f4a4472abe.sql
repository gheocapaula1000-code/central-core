ALTER TABLE public.padova_collect_v2_items
  ADD COLUMN IF NOT EXISTS agency_phone text;

CREATE INDEX IF NOT EXISTS idx_pcvi_agency_lower
  ON public.padova_collect_v2_items (lower(agency))
  WHERE contendibile = true;