ALTER TABLE public.trovabandi_sources
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'CATALOGO',
  ADD COLUMN IF NOT EXISTS rarity_base smallint NOT NULL DEFAULT 2;

DO $$ BEGIN
  ALTER TABLE public.trovabandi_sources
    ADD CONSTRAINT trovabandi_sources_kind_check
    CHECK (source_kind IN ('CATALOGO', 'BUR', 'ALBO_PRETORIO', 'CAMERALE', 'GAL', 'FONDAZIONE', 'DECRETO', 'EU_PORTAL'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.trovabandi_sources
    ADD CONSTRAINT trovabandi_sources_rarity_check CHECK (rarity_base BETWEEN 1 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.trovabandi_opportunities
  ADD COLUMN IF NOT EXISTS rarity_score smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'CATALOGO',
  ADD COLUMN IF NOT EXISTS publication_reference text;

DO $$ BEGIN
  ALTER TABLE public.trovabandi_opportunities
    ADD CONSTRAINT trovabandi_opportunities_rarity_check CHECK (rarity_score BETWEEN 1 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO public.trovabandi_sources
  (name, authority_level, region, province, official_domain, search_query, priority, source_kind, rarity_base)
VALUES
  ('Bollettino Ufficiale Regione Veneto', 'REGIONALE', 'Veneto', NULL, 'bur.regione.veneto.it', 'DGR allegato bando contributi imprese fondo perduto apertura domande', 100, 'BUR', 5),
  ('CCIAA Padova - contributi', 'CAMERALE', 'Veneto', 'PD', 'pd.camcom.it', 'bandi contributi premi imprese domande apertura 2026', 100, 'CAMERALE', 4),
  ('Albo e atti Comune di Padova', 'COMUNALE', 'Veneto', 'PD', 'padovanet.it', 'albo pretorio delibera avviso contributi attività economiche imprese allegato', 96, 'ALBO_PRETORIO', 5),
  ('GAL Patavino', 'COMUNALE', 'Veneto', 'PD', 'galpatavino.it', 'nuovo bando pubblico imprese contributo fondo perduto prossima pubblicazione', 98, 'GAL', 5)
ON CONFLICT (official_domain, search_query) DO UPDATE SET
  source_kind = EXCLUDED.source_kind,
  rarity_base = EXCLUDED.rarity_base,
  priority = EXCLUDED.priority,
  enabled = true,
  updated_at = now();