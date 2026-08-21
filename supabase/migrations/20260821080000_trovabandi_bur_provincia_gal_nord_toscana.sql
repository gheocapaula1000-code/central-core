-- TrovaBandi: BUR + provincia/CM + GAL (Veneto, poi Toscana) Nord→Toscana.
-- Solo URL ufficiali verificati live (HTTP 200) il 21/08/2026.
-- Nessun nuovo cron, nessun secret, nessuna opportunity inventata.
-- Non duplica: BUR Veneto, Provincia Padova, GAL Patavino, CCIAA già in repo.
-- Entità senza pagina live confermata: omesse (elenco nel PR).

INSERT INTO public.trovabandi_sources
  (name, authority_level, region, province, official_domain, search_query, enabled, priority, source_kind, scan_interval_minutes, next_scan_at)
VALUES
  -- BUR / bollettini ufficiali (Veneto già presente su bur.regione.veneto.it)
  ('Bollettino Ufficiale Regione Piemonte', 'REGIONALE', 'Piemonte', NULL, 'regione.piemonte.it',
   'DGR allegato bando contributi imprese fondo perduto apertura domande', true, 100, 'BUR', 60, now()),
  ('Bollettino Ufficiale Regione Lombardia — BURL', 'REGIONALE', 'Lombardia', NULL, 'regione.lombardia.it',
   'DGR allegato bando contributi imprese fondo perduto apertura domande', true, 100, 'BUR', 60, now()),
  ('Bollettino Ufficiale Regione Liguria — BURL', 'REGIONALE', 'Liguria', NULL, 'burl.it',
   'DGR allegato bando contributi imprese fondo perduto apertura domande', true, 100, 'BUR', 60, now()),
  ('Bollettino Ufficiale Regione Friuli Venezia Giulia', 'REGIONALE', 'Friuli-Venezia Giulia', NULL, 'bur.regione.fvg.it',
   'DGR allegato bando contributi imprese fondo perduto apertura domande', true, 100, 'BUR', 60, now()),
  ('Bollettino Ufficiale Regione Emilia-Romagna — BURERT', 'REGIONALE', 'Emilia-Romagna', NULL, 'bur.regione.emilia-romagna.it',
   'DGR allegato bando contributi imprese fondo perduto apertura domande', true, 100, 'BUR', 60, now()),
  ('Bollettino Ufficiale Regione Toscana — BURT', 'REGIONALE', 'Toscana', NULL, 'regione.toscana.it',
   'DGR allegato bando contributi imprese fondo perduto apertura domande', true, 100, 'BUR', 60, now()),
  ('Bollettino Ufficiale Regione Valle d''Aosta', 'REGIONALE', 'Valle d''Aosta', NULL, 'regione.vda.it',
   'DGR allegato bando contributi imprese fondo perduto apertura domande', true, 100, 'BUR', 60, now()),

  -- Provincia / Città metropolitana (Padova già presente)
  ('Città Metropolitana di Venezia — sovvenzioni e contributi', 'REGIONALE', 'Veneto', 'VE', 'cittametropolitana.ve.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Treviso — sovvenzioni e contributi', 'REGIONALE', 'Veneto', 'TV', 'amministrazionetrasparente.provincia.treviso.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Provincia di Cuneo — sovvenzioni e contributi', 'REGIONALE', 'Piemonte', 'CN', 'provincia.cuneo.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),
  ('Città Metropolitana di Firenze — sovvenzioni e contributi', 'REGIONALE', 'Toscana', 'FI', 'cittametropolitana.fi.it',
   'sovvenzioni contributi sussidi bandi imprese associazioni domande aperte', true, 97, 'CATALOGO', 60, now()),

  -- GAL Veneto 2023-2027 (elenco Regione Veneto LEADER; Patavino già presente)
  ('GAL Alto Bellunese', 'COMUNALE', 'Veneto', 'BL', 'galaltobellunese.com',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),
  ('GAL Prealpi e Dolomiti', 'COMUNALE', 'Veneto', 'BL', 'galprealpidolomiti.it',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),
  ('GAL Baldo Lessinia', 'COMUNALE', 'Veneto', 'VR', 'baldolessinia.it',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),
  ('GAL Alta Marca Trevigiana', 'COMUNALE', 'Veneto', 'TV', 'galaltamarca.tv.it',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),
  ('GAL Montagna Vicentina', 'COMUNALE', 'Veneto', 'VI', 'montagnavicentina.com',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),
  ('GAL Delta Po', 'COMUNALE', 'Veneto', 'RO', 'galdeltapo.it',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),
  ('GAL Adige', 'COMUNALE', 'Veneto', 'RO', 'galadige.it',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),
  ('GAL Venezia Orientale — VeGAL', 'COMUNALE', 'Veneto', 'VE', 'vegal.net',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),

  -- GAL Toscana 2023-2027 (siti in tabella Anci Toscana; pagine bandi verificate sul dominio GAL)
  ('GAL MontagnAppennino', 'COMUNALE', 'Toscana', 'LU', 'montagnappennino.it',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),
  ('GAL START', 'COMUNALE', 'Toscana', 'FI', 'gal-start.it',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),
  ('GAL Terre Etrusche', 'COMUNALE', 'Toscana', 'PI', 'galterretrusche.com',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),
  ('GAL F.A.R. Maremma', 'COMUNALE', 'Toscana', 'GR', 'farmaremma.it',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),
  ('GAL Leader Siena', 'COMUNALE', 'Toscana', 'SI', 'leadersiena.it',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),
  ('GAL Appennino Aretino', 'COMUNALE', 'Toscana', 'AR', 'galaretino.it',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now()),
  ('GAL Consorzio Lunigiana', 'COMUNALE', 'Toscana', 'MS', 'sviluppolunigiana.it',
   'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', true, 98, 'GAL', 60, now())
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
