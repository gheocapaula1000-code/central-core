
ALTER TABLE public.obituaries_aggregate_padova
  DROP CONSTRAINT IF EXISTS obituaries_aggregate_padova_source_code_check;
ALTER TABLE public.obituaries_aggregate_padova
  ADD CONSTRAINT obituaries_aggregate_padova_source_code_check
  CHECK (source_code IN (
    'F19',
    'il_mattino_di_padova_necrologie',
    'necrologi_padova_brogio',
    'merged_multi_source'
  ));
