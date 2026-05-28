
ALTER TABLE public.obituaries_aggregate_padova
  ADD COLUMN IF NOT EXISTS source_code      TEXT        NOT NULL DEFAULT 'F19',
  ADD COLUMN IF NOT EXISTS confidence       TEXT        NOT NULL DEFAULT 'low',
  ADD COLUMN IF NOT EXISTS last_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS visible_to_pwa   BOOLEAN     NOT NULL DEFAULT false;

ALTER TABLE public.obituaries_aggregate_padova
  DROP CONSTRAINT IF EXISTS obituaries_aggregate_padova_source_code_check;
ALTER TABLE public.obituaries_aggregate_padova
  ADD  CONSTRAINT obituaries_aggregate_padova_source_code_check
  CHECK (source_code = 'F19');

ALTER TABLE public.obituaries_aggregate_padova
  DROP CONSTRAINT IF EXISTS obituaries_aggregate_padova_confidence_check;
ALTER TABLE public.obituaries_aggregate_padova
  ADD  CONSTRAINT obituaries_aggregate_padova_confidence_check
  CHECK (confidence IN ('low','medium','high'));

ALTER TABLE public.obituaries_aggregate_padova
  DROP CONSTRAINT IF EXISTS obituaries_aggregate_padova_visible_pwa_check;
ALTER TABLE public.obituaries_aggregate_padova
  ADD  CONSTRAINT obituaries_aggregate_padova_visible_pwa_check
  CHECK (visible_to_pwa = false);
