ALTER TABLE public.padova_collect_v2_items
  ADD COLUMN IF NOT EXISTS previous_price_eur numeric,
  ADD COLUMN IF NOT EXISTS ribasso_pct numeric,
  ADD COLUMN IF NOT EXISTS ribasso_eur numeric,
  ADD COLUMN IF NOT EXISTS ribasso_date timestamptz;