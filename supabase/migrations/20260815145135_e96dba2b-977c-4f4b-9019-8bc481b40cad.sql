INSERT INTO public.trovabandi_sources
  (name, authority_level, region, province, official_domain, search_query, enabled, priority, source_kind, scan_interval_minutes, next_scan_at)
VALUES
  ('Provincia di Padova — contributi', 'REGIONALE', 'Veneto', 'PD', 'provincia.pd.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Padova — sito', 'REGIONALE', 'Veneto', 'PD', 'provincia.padova.it',
   'bando contributi imprese comuni domande aperte 2026', true, 96, 'CATALOGO', 60, now())
ON CONFLICT (official_domain, search_query) DO UPDATE SET
  name = EXCLUDED.name,
  authority_level = EXCLUDED.authority_level,
  region = EXCLUDED.region,
  province = EXCLUDED.province,
  enabled = true,
  priority = EXCLUDED.priority,
  source_kind = EXCLUDED.source_kind,
  scan_interval_minutes = EXCLUDED.scan_interval_minutes,
  next_scan_at = now(),
  updated_at = now();