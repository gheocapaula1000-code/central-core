ALTER TABLE public.area_opportunity_scores
  ADD COLUMN IF NOT EXISTS area_label text,
  ADD COLUMN IF NOT EXISTS lat double precision,
  ADD COLUMN IF NOT EXISTS lng double precision,
  ADD COLUMN IF NOT EXISTS area_type text,
  ADD COLUMN IF NOT EXISTS property_types text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS derivazione text,
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone NOT NULL DEFAULT now();

ALTER TABLE public.area_opportunity_scores
  ALTER COLUMN score DROP NOT NULL,
  ALTER COLUMN temperature DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS area_opportunity_scores_municipality_area_label_key
  ON public.area_opportunity_scores (municipality, area_label);