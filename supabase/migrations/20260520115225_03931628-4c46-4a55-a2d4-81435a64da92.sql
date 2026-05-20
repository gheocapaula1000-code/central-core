
UPDATE public.early_warning_opportunities
SET confidence = 'media',
    primary_signal_type = CASE WHEN primary_signal_type = 'MICROZONE_PRESSURE_HIGH'
                               THEN 'MICROZONE_PRESSURE' ELSE primary_signal_type END,
    early_acquisition_score = GREATEST(0, early_acquisition_score - 20),
    warnings = array_append(COALESCE(warnings, '{}'::text[]), 'audit_downgrade:city_level_sources_insufficient'),
    updated_at = now()
WHERE is_active = true
  AND comune ILIKE 'padova'
  AND confidence = 'alta'
  AND NOT EXISTS (
    SELECT 1 FROM public.legal_life_event_signals l
    WHERE l.is_active = true AND l.privacy_safe = true AND l.pii_redacted = true
      AND l.confidence = 'alta'
      AND lower(coalesce(l.area_or_microzone,'')) LIKE '%' || lower(early_warning_opportunities.area_label) || '%'
  );
