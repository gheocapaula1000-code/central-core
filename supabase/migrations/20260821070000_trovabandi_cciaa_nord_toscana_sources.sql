-- TrovaBandi: CCIAA Nord + Toscana (camere e accorpamenti).
-- Domini presi dall'elenco ufficiale Unioncamere
-- https://www.unioncamere.gov.it/elenco-delle-camere-di-commercio-italiane
-- e verificati live (HTTP 200) sulle pagine bandi/contributi.
-- Nessun nuovo cron, nessun secret, nessuna opportunity inventata.
-- Già presenti e non duplicati: pd.camcom.it, vi.camcom.it,
-- dl.camcom.it, tb.camcom.gov.it, unioncamere.gov.it, unioncamereveneto.it.

INSERT INTO public.trovabandi_sources
  (name, authority_level, region, province, official_domain, search_query, enabled, priority, source_kind, scan_interval_minutes, next_scan_at)
VALUES
  -- Valle d'Aosta
  ('CCIAA Valdostana — bandi e contributi', 'CAMERALE', 'Valle d''Aosta', 'AO', 'ao.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),

  -- Piemonte
  ('CCIAA Alessandria-Asti — bandi e contributi', 'CAMERALE', 'Piemonte', 'AL', 'aa.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Cuneo — bandi e contributi', 'CAMERALE', 'Piemonte', 'CN', 'cn.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Monte Rosa Laghi Alto Piemonte — bandi', 'CAMERALE', 'Piemonte', 'VC', 'pno.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Torino — bandi e contributi', 'CAMERALE', 'Piemonte', 'TO', 'to.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),

  -- Liguria
  ('CCIAA Genova — bandi e contributi', 'CAMERALE', 'Liguria', 'GE', 'ge.camcom.gov.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Riviere di Liguria — bandi', 'CAMERALE', 'Liguria', 'SV', 'rivlig.camcom.gov.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),

  -- Lombardia
  ('CCIAA Bergamo — bandi e contributi', 'CAMERALE', 'Lombardia', 'BG', 'bg.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Brescia — bandi e contributi', 'CAMERALE', 'Lombardia', 'BS', 'bs.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Como-Lecco — bandi e contributi', 'CAMERALE', 'Lombardia', 'CO', 'comolecco.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Cremona-Mantova-Pavia — bandi', 'CAMERALE', 'Lombardia', 'MN', 'cmp.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Milano Monza Brianza Lodi — bandi', 'CAMERALE', 'Lombardia', 'MI', 'milomb.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Sondrio — bandi e contributi', 'CAMERALE', 'Lombardia', 'SO', 'so.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Varese — bandi e contributi', 'CAMERALE', 'Lombardia', 'VA', 'va.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),

  -- Veneto restante (VE/RO già coperti da dl.camcom.it)
  ('CCIAA Verona — bandi e contributi', 'CAMERALE', 'Veneto', 'VR', 'vr.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),

  -- Friuli-Venezia Giulia
  ('CCIAA Pordenone-Udine — bandi e contributi', 'CAMERALE', 'Friuli-Venezia Giulia', 'UD', 'pnud.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Venezia Giulia — bandi e contributi', 'CAMERALE', 'Friuli-Venezia Giulia', 'TS', 'vg.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),

  -- Emilia-Romagna
  ('CCIAA Bologna — bandi e contributi', 'CAMERALE', 'Emilia-Romagna', 'BO', 'bo.camcom.gov.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Emilia — bandi e contributi', 'CAMERALE', 'Emilia-Romagna', 'PR', 'emilia.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Ferrara-Ravenna — bandi e contributi', 'CAMERALE', 'Emilia-Romagna', 'RA', 'fera.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Modena — bandi e contributi', 'CAMERALE', 'Emilia-Romagna', 'MO', 'mo.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Romagna — bandi e contributi', 'CAMERALE', 'Emilia-Romagna', 'FC', 'romagna.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),

  -- Toscana
  ('CCIAA Arezzo-Siena — bandi e contributi', 'CAMERALE', 'Toscana', 'AR', 'as.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Firenze — bandi e contributi', 'CAMERALE', 'Toscana', 'FI', 'fi.camcom.gov.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Maremma e Tirreno — bandi', 'CAMERALE', 'Toscana', 'LI', 'lg.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Pistoia-Prato — bandi e contributi', 'CAMERALE', 'Toscana', 'PO', 'ptpo.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Toscana Nord-Ovest — bandi', 'CAMERALE', 'Toscana', 'LU', 'tno.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),

  -- Trento / Bolzano: cataloghi provinciali già presenti; queste sono
  -- pagine bandi distinte sul dominio camerale, verificate live.
  ('CCIAA Trento — bandi e contributi', 'CAMERALE', 'Trentino-Alto Adige', 'TN', 'tn.camcom.it',
   'bandi contributi voucher imprese domande aperte', true, 90, 'CATALOGO', 60, now()),
  ('CCIAA Bolzano — bandi e contributi', 'CAMERALE', 'Trentino-Alto Adige', 'BZ', 'camcom.bz.it',
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
