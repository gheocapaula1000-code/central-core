
-- Estende source_documents per pipeline Firecrawl deep
ALTER TABLE public.source_documents
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS text_excerpt text,
  ADD COLUMN IF NOT EXISTS markdown text,
  ADD COLUMN IF NOT EXISTS raw_hash text,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS comune text,
  ADD COLUMN IF NOT EXISTS provincia text,
  ADD COLUMN IF NOT EXISTS classification text,
  ADD COLUMN IF NOT EXISTS extracted_entities jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS relevance_score numeric,
  ADD COLUMN IF NOT EXISTS confidence_score numeric,
  ADD COLUMN IF NOT EXISTS freshness_score numeric,
  ADD COLUMN IF NOT EXISTS importability boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS import_reason text,
  ADD COLUMN IF NOT EXISTS quality text DEFAULT 'parziale',
  ADD COLUMN IF NOT EXISTS data_basis text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS source_documents_url_uniq
  ON public.source_documents (source_url) WHERE source_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_documents_class_idx
  ON public.source_documents (classification, provincia, comune);
CREATE INDEX IF NOT EXISTS source_documents_hash_idx
  ON public.source_documents (raw_hash) WHERE raw_hash IS NOT NULL;
