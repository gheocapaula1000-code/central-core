-- TrovaBandi: province venete ancora senza official_domain in catalogo.
-- Solo Veneto. Nessun Centro-Sud, nessun BUR FVG, nessun Comune (560),
-- Padova albo invariato. Nessun nuovo cron, nessun secret, nessuna
-- opportunity inventata.
-- Listing verificate live il 22 Aug 2026:
--   Vicenza AT sovvenzioni (www2.provincia.vicenza.it) — pagina ufficiale
--   HTTP 200, titolo "Sovvenzioni, contributi, sussidi, vantaggi economici".
--   Verona contributi e patrocini (web.provincia.vr.it) — già in live Core;
--   manca su main (PR #46 la mescola a 17 province extra-Veneto).
-- Omesse (nessuna listing stabile HTTP 200): Provincia di Belluno
-- (myPortal stub; AT portaleservizi 403 / URL CSRF), Provincia di Rovigo
-- (myPortal stub; rovigo.trasparenza-valutazione-merito.it è Comune).
-- CCIAA / CM Venezia / GAL 2023-2027 / Unioncamere Veneto già presenti.

INSERT INTO public.trovabandi_sources
  (name, authority_level, region, province, official_domain, search_query, enabled, priority, source_kind, scan_interval_minutes, next_scan_at)
VALUES
  ('Provincia di Vicenza — sovvenzioni e contributi', 'REGIONALE', 'Veneto', 'VI', 'provincia.vicenza.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Verona — contributi e patrocini', 'REGIONALE', 'Veneto', 'VR', 'web.provincia.vr.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now())
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
