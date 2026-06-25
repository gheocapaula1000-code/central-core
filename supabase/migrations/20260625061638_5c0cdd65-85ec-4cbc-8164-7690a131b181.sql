ALTER TABLE public.b2b_companies
  ADD CONSTRAINT b2b_companies_score_check
  CHECK (score IS NULL OR (score BETWEEN 0 AND 100));