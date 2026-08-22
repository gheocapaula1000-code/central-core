ALTER TABLE public.trovabandi_opportunities
  ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS trovabandi_opportunities_hidden_rarity_idx
  ON public.trovabandi_opportunities (is_hidden, rarity_score DESC, deadline_at);

INSERT INTO public.trovabandi_sources
  (name, authority_level, region, province, official_domain, search_query,
   enabled, priority, source_kind, rarity_base, scan_interval_minutes, next_scan_at)
VALUES
  ('Comune di Padova — albo pretorio online', 'COMUNALE', 'Veneto', 'PD', 'comune.padova.it',
   'albo pretorio avvisi deliberazioni contributi imprese', true, 100, 'ALBO_PRETORIO', 5, 240, now()),
  ('Comune di Padova — avvisi pubblici', 'COMUNALE', 'Veneto', 'PD', 'comune.padova.it',
   'avvisi pubblici contributi manifestazioni di interesse albi imprese', true, 100, 'ALBO_PRETORIO', 5, 360, now()),
  ('Comune di Padova — amministrazione trasparente bandi', 'COMUNALE', 'Veneto', 'PD', 'comune.padova.it',
   'bandi di gara e contratti avvisi aperti a imprese', true, 99, 'ALBO_PRETORIO', 5, 720, now()),
  ('Provincia di Padova — albo pretorio', 'COMUNALE', 'Veneto', 'PD', 'provincia.pd.it',
   'albo pretorio atti avvisi provinciali contributi imprese', true, 99, 'ALBO_PRETORIO', 5, 360, now()),
  ('Regione Veneto — portale bandi', 'REGIONALE', 'Veneto', NULL, 'bandi.regione.veneto.it',
   'bandi aperti contributi imprese Veneto', true, 96, 'CATALOGO', 3, 360, now()),
  ('Regione Veneto — sviluppo rurale e agricoltura', 'REGIONALE', 'Veneto', NULL, 'regione.veneto.it',
   'bandi finanziamenti agricoltura sviluppo rurale imprese', true, 96, 'CATALOGO', 3, 360, now())
ON CONFLICT (official_domain, search_query) DO UPDATE SET
  name = EXCLUDED.name,
  authority_level = EXCLUDED.authority_level,
  region = EXCLUDED.region,
  province = EXCLUDED.province,
  enabled = true,
  priority = EXCLUDED.priority,
  source_kind = EXCLUDED.source_kind,
  rarity_base = EXCLUDED.rarity_base,
  scan_interval_minutes = EXCLUDED.scan_interval_minutes,
  next_scan_at = now(),
  updated_at = now();

UPDATE public.trovabandi_sources
SET rarity_base = GREATEST(COALESCE(rarity_base, 1), 4), updated_at = now()
WHERE (
    authority_level IN ('COMUNALE', 'CAMERALE')
    OR source_kind IN ('GAL', 'ALBO_PRETORIO', 'CAMERALE')
    OR name ILIKE 'GAL %'
  )
  AND COALESCE(rarity_base, 1) < 4;

UPDATE public.trovabandi_opportunities
SET is_hidden = true,
    rarity_score = GREATEST(COALESCE(rarity_score, 1), 4)
WHERE authority_level IN ('COMUNALE', 'CAMERALE')
  AND (is_hidden = false OR COALESCE(rarity_score, 1) < 4);

UPDATE public.trovabandi_opportunities
SET is_hidden = true,
    rarity_score = 5
WHERE (lower(official_url) LIKE '%.pdf%' OR lower(official_url) LIKE '%/documento%')
  AND (
    lower(official_url) LIKE '%amministrazione-trasparente%'
    OR lower(official_url) LIKE '%amministrazionetrasparente%'
    OR lower(official_url) LIKE '%/trasparente%'
    OR lower(official_url) LIKE '%albo-pretorio%'
    OR lower(official_url) LIKE '%albopretorio%'
    OR lower(official_url) LIKE '%/albo%'
  )
  AND (is_hidden = false OR COALESCE(rarity_score, 1) < 5);