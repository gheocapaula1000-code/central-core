-- TrovaBandi: CCIAA Venezia Rovigo Delta Lagunare (elenco Unioncamere).
-- https://unioncamere.gov.it/sistema-camerale/elenco-delle-camere-di-commercio-italiane
-- Unioncamere assegna https://www.dl.camcom.it/ a questa Camera
-- (sede legale Venezia). La riga produzione esiste già su quel dominio
-- con etichetta Treviso-Belluno: stesso unique key, nessun secondo insert.
-- Listing bandi verificata HTTP 200 il 21 Aug 2026:
-- https://www.dl.camcom.it/sonoimpresa/cosa-puo-servire-sono/incentivi-ed-agevolazioni
-- Treviso-Belluno resta su tb.camcom.gov.it. Nessun albo comunale.

INSERT INTO public.trovabandi_sources
  (name, authority_level, region, province, official_domain, search_query, enabled, priority, source_kind, scan_interval_minutes, next_scan_at)
VALUES
  ('CCIAA Venezia Rovigo Delta Lagunare — bandi', 'CAMERALE', 'Veneto', 'VE', 'dl.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now())
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
