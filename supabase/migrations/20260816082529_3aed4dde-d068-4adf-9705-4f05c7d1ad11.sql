-- TrovaBandi: aggiunta fonti camerali venete mancanti.
-- Solo 4 domini camerali, nessun nuovo cron, nessun secret.
INSERT INTO public.trovabandi_sources
  (name, authority_level, region, province, official_domain, search_query, enabled, priority, source_kind, scan_interval_minutes, next_scan_at)
VALUES
  ('CCIAA Vicenza — bandi e contributi', 'CAMERALE', 'Veneto', 'VI', 'vi.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Treviso-Belluno|Dolomiti — bandi', 'CAMERALE', 'Veneto', 'TV', 'dl.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Treviso-Belluno|Dolomiti — portale istituzionale', 'CAMERALE', 'Veneto', 'TV', 'tb.camcom.gov.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('Unioncamere del Veneto — bandi', 'CAMERALE', 'Veneto', NULL, 'unioncamereveneto.it',
   'bandi contributi imprese veneto domande aperte', true, 90, 'CATALOGO', 60, now())
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