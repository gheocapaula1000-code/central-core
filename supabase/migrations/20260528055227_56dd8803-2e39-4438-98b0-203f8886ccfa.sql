-- Dedupe: keep newest observed_at per (entity, source, type)
DELETE FROM public.civiko_evidence a
USING public.civiko_evidence b
WHERE a.entity_type = b.entity_type
  AND a.entity_key = b.entity_key
  AND a.source_code = b.source_code
  AND a.evidence_type = b.evidence_type
  AND (a.observed_at, a.id) < (b.observed_at, b.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_civiko_evidence_entity_source_type
  ON public.civiko_evidence (entity_type, entity_key, source_code, evidence_type);