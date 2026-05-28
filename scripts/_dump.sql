COPY (
  SELECT json_agg(t) FROM (
    SELECT entity_type,entity_key,source_code,evidence_type,evidence_value,confidence,freshness_days,observed_at,explanation,raw_ref_id,compliance_visibility
    FROM civiko_evidence
    WHERE compliance_visibility IN ('public','admin_only')
    ORDER BY observed_at DESC LIMIT 10000
  ) t
) TO STDOUT
