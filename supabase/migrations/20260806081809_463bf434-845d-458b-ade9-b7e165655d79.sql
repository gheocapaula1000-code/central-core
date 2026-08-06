INSERT INTO public.trovabandi_sources
  (name, authority_level, region, official_domain, search_query, priority, source_kind, rarity_base)
VALUES
  ('Regione Abruzzo', 'REGIONALE', 'Abruzzo', 'regione.abruzzo.it', 'bando contributi imprese fondo perduto allegato apertura domande', 90, 'CATALOGO', 3),
  ('Regione Basilicata', 'REGIONALE', 'Basilicata', 'regione.basilicata.it', 'bando contributi imprese fondo perduto allegato apertura domande', 90, 'CATALOGO', 3),
  ('Regione Calabria', 'REGIONALE', 'Calabria', 'regione.calabria.it', 'bando contributi imprese fondo perduto allegato apertura domande', 90, 'CATALOGO', 3),
  ('Regione Friuli Venezia Giulia', 'REGIONALE', 'Friuli-Venezia Giulia', 'regione.fvg.it', 'bando contributi imprese fondo perduto allegato apertura domande', 90, 'CATALOGO', 3),
  ('Regione Liguria', 'REGIONALE', 'Liguria', 'regione.liguria.it', 'bando contributi imprese fondo perduto allegato apertura domande', 90, 'CATALOGO', 3),
  ('Regione Marche', 'REGIONALE', 'Marche', 'regione.marche.it', 'bando contributi imprese fondo perduto allegato apertura domande', 90, 'CATALOGO', 3),
  ('Regione Molise', 'REGIONALE', 'Molise', 'regione.molise.it', 'bando contributi imprese fondo perduto allegato apertura domande', 90, 'CATALOGO', 3),
  ('Provincia autonoma di Trento', 'REGIONALE', 'Trentino-Alto Adige', 'provincia.tn.it', 'bando contributi imprese agevolazioni allegato apertura domande', 90, 'CATALOGO', 3),
  ('Provincia autonoma di Bolzano', 'REGIONALE', 'Trentino-Alto Adige', 'provincia.bz.it', 'bando contributi imprese agevolazioni allegato apertura domande', 90, 'CATALOGO', 3),
  ('Regione Umbria', 'REGIONALE', 'Umbria', 'regione.umbria.it', 'bando contributi imprese fondo perduto allegato apertura domande', 90, 'CATALOGO', 3),
  ('Regione Valle d''Aosta', 'REGIONALE', 'Valle d''Aosta', 'regione.vda.it', 'bando contributi imprese agevolazioni allegato apertura domande', 90, 'CATALOGO', 3),
  ('Gazzetta Ufficiale', 'NAZIONALE', NULL, 'gazzettaufficiale.it', 'decreto attuativo agevolazioni contributi imprese allegato domande', 94, 'DECRETO', 5),
  ('Ministero Ambiente e Sicurezza Energetica', 'NAZIONALE', NULL, 'mase.gov.it', 'avviso bando contributi imprese transizione energetica decreto', 92, 'DECRETO', 4),
  ('Politiche di coesione', 'NAZIONALE', NULL, 'politichecoesione.governo.it', 'avviso imprese fondi coesione contributi bando', 90, 'DECRETO', 4),
  ('Dipartimento Pari Opportunità', 'NAZIONALE', NULL, 'pariopportunita.gov.it', 'avviso bando imprenditoria femminile contributi imprese', 94, 'DECRETO', 4),
  ('Dipartimento Politiche Giovanili', 'NAZIONALE', NULL, 'politichegiovanili.gov.it', 'avviso bando imprenditoria giovanile startup contributi', 92, 'DECRETO', 4)
ON CONFLICT (official_domain, search_query) DO UPDATE SET
  name = EXCLUDED.name,
  authority_level = EXCLUDED.authority_level,
  region = EXCLUDED.region,
  source_kind = EXCLUDED.source_kind,
  rarity_base = EXCLUDED.rarity_base,
  priority = EXCLUDED.priority,
  enabled = true,
  updated_at = now();