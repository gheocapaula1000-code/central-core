-- TrovaBandi: province / città metropolitane restanti Nord→Toscana.
-- Solo listing ufficiali verificati HTTP 200 il 21/08/2026, estratti
-- dagli indici Amministrazione Trasparente dei siti Wikidata (P856)
-- o da menu istituzionali "contributi / sovvenzioni".
-- Nessun path indovinato 404, nessuna homepage, nessuno stub myPortal,
-- nessun albo comunale, nessun nuovo cron, nessuna opportunity inventata.
-- Non duplica: Padova, Venezia CM, Treviso AT, Cuneo, Firenze CM,
-- Trento (provincia.tn.it), Bolzano (provincia.bz.it).

INSERT INTO public.trovabandi_sources
  (name, authority_level, region, province, official_domain, search_query, enabled, priority, source_kind, scan_interval_minutes, next_scan_at)
VALUES
  ('Città Metropolitana di Torino — sovvenzioni e contributi', 'REGIONALE', 'Piemonte', 'TO', 'trasparenza.cittametropolitana.torino.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Città Metropolitana di Genova — sovvenzioni e contributi', 'REGIONALE', 'Liguria', 'GE', 'dati.cittametropolitana.genova.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Imperia — sovvenzioni e contributi', 'REGIONALE', 'Liguria', 'IM', 'provincia.imperia.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Savona — sovvenzioni e contributi', 'REGIONALE', 'Liguria', 'SV', 'provincia.savona.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Città Metropolitana di Milano — sovvenzioni e contributi', 'REGIONALE', 'Lombardia', 'MI', 'cittametropolitana.mi.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Brescia — sovvenzioni e contributi', 'REGIONALE', 'Lombardia', 'BS', 'at.provincia.brescia.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Como — sovvenzioni e contributi', 'REGIONALE', 'Lombardia', 'CO', 'provincia.como.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Cremona — sovvenzioni e contributi', 'REGIONALE', 'Lombardia', 'CR', 'provincia.cremona.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Lecco — sovvenzioni e contributi', 'REGIONALE', 'Lombardia', 'LC', 'provincia.lecco.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Mantova — bandi per contributi', 'REGIONALE', 'Lombardia', 'MN', 'provincia.mantova.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Sondrio — sovvenzioni e contributi', 'REGIONALE', 'Lombardia', 'SO', 'provinciasondrio.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Verona — contributi e patrocini', 'REGIONALE', 'Veneto', 'VR', 'web.provincia.vr.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Ravenna — sovvenzioni e contributi', 'REGIONALE', 'Emilia-Romagna', 'RA', 'provincia.ra.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Piacenza — sovvenzioni e contributi', 'REGIONALE', 'Emilia-Romagna', 'PC', 'amministrazionetrasparente.provincia.pc.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Arezzo — sovvenzioni e contributi', 'REGIONALE', 'Toscana', 'AR', 'provincia.arezzo.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Livorno — sovvenzioni e contributi', 'REGIONALE', 'Toscana', 'LI', 'ammtrasp.provincia.livorno.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Massa-Carrara — sovvenzioni e contributi', 'REGIONALE', 'Toscana', 'MS', 'provinciams.etrasparenza.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Pistoia — sovvenzioni e contributi', 'REGIONALE', 'Toscana', 'PT', 'trasparenza.provincia.pistoia.it',
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
