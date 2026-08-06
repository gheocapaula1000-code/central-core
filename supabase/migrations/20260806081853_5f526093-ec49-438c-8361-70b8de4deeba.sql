ALTER TABLE public.trovabandi_opportunities
  ADD COLUMN IF NOT EXISTS programme_name text,
  ADD COLUMN IF NOT EXISTS programme_code text,
  ADD COLUMN IF NOT EXISTS pnrr_mission text,
  ADD COLUMN IF NOT EXISTS pnrr_component text,
  ADD COLUMN IF NOT EXISTS implementing_body text,
  ADD COLUMN IF NOT EXISTS eligible_countries text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS consortium_required boolean,
  ADD COLUMN IF NOT EXISTS min_partners integer,
  ADD COLUMN IF NOT EXISTS direct_applicant_allowed boolean;

ALTER TABLE public.trovabandi_opportunities
  DROP CONSTRAINT IF EXISTS trovabandi_opportunities_category_check;
ALTER TABLE public.trovabandi_opportunities
  ADD CONSTRAINT trovabandi_opportunities_category_check CHECK (category IN (
    'FONDO_PERDUTO', 'FINANZIAMENTO_AGEVOLATO', 'TASSO_ZERO', 'CREDITO_IMPOSTA',
    'GARANZIA', 'VOUCHER', 'IMPRENDITORIA_FEMMINILE', 'IMPRENDITORIA_GIOVANILE',
    'DIGITALIZZAZIONE', 'TRANSIZIONE_ENERGETICA', 'RICERCA_SVILUPPO',
    'INTERNAZIONALIZZAZIONE', 'STARTUP_INNOVAZIONE', 'FORMAZIONE_OCCUPAZIONE',
    'AGRICOLTURA_RURALE', 'TURISMO_CULTURA', 'ECONOMIA_CIRCOLARE', 'ALTRO'
  ));

CREATE INDEX IF NOT EXISTS trovabandi_opportunities_programme_idx
  ON public.trovabandi_opportunities (programme_code, pnrr_mission);

ALTER TABLE public.trovabandi_refresh_requests
  ADD COLUMN IF NOT EXISTS municipality text,
  ADD COLUMN IF NOT EXISTS company_size text,
  ADD COLUMN IF NOT EXISTS interest_categories text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS female_business boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS youth_business boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS innovative_business boolean NOT NULL DEFAULT false;

COMMENT ON TABLE public.trovabandi_refresh_requests IS
  'Minimised, non-identifying search signals. Never store company name, VAT number, email, PEC or contacts here.';

ALTER TABLE public.trovabandi_sources
  ADD COLUMN IF NOT EXISTS fast_lane boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scan_interval_minutes integer NOT NULL DEFAULT 360;

DO $$ BEGIN
  ALTER TABLE public.trovabandi_sources
    ADD CONSTRAINT trovabandi_sources_scan_interval_check
    CHECK (scan_interval_minutes BETWEEN 15 AND 10080);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO public.trovabandi_sources
  (name, authority_level, region, official_domain, search_query, priority, source_kind, rarity_base)
VALUES
  ('EU Funding & Tenders Portal', 'EU', NULL, 'funding-tenders.ec.europa.eu', 'open call grants SME startup Italy deadline topic funding tender', 100, 'EU_PORTAL', 4),
  ('Commissione UE - programmi e fondi', 'EU', NULL, 'commission.europa.eu', 'EU funding programme open calls grants SMEs entrepreneurs digital green', 96, 'EU_PORTAL', 3),
  ('European Innovation Council', 'EU', NULL, 'eic.ec.europa.eu', 'EIC Accelerator Transition Pathfinder open funding startup SME women leadership', 99, 'EU_PORTAL', 4),
  ('EISMEA - PMI e imprenditoria', 'EU', NULL, 'eismea.ec.europa.eu', 'open upcoming calls SMEs startup women entrepreneurs young entrepreneurs grants', 99, 'EU_PORTAL', 4),
  ('Digital Europe', 'EU', NULL, 'digital-strategy.ec.europa.eu', 'Digital Europe open calls AI cybersecurity data skills SME funding', 97, 'EU_PORTAL', 4),
  ('Horizon Europe', 'EU', NULL, 'research-and-innovation.ec.europa.eu', 'Horizon Europe open calls innovation research SMEs grants Italy', 97, 'EU_PORTAL', 4),
  ('CINEA - LIFE energia clima', 'EU', NULL, 'cinea.ec.europa.eu', 'open calls LIFE clean energy climate circular economy SME grant', 96, 'EU_PORTAL', 4),
  ('European Social Fund Plus', 'EU', NULL, 'european-social-fund-plus.ec.europa.eu', 'ESF Plus calls employment training social innovation entrepreneurship Italy', 94, 'EU_PORTAL', 4),
  ('Interreg Europe', 'EU', NULL, 'interregeurope.eu', 'open call projects SMEs innovation green digital partners Italy', 93, 'EU_PORTAL', 5),
  ('Commissione UE - agricoltura PAC', 'EU', NULL, 'agriculture.ec.europa.eu', 'funding opportunities calls agriculture rural young farmers innovation Italy', 94, 'EU_PORTAL', 4),
  ('Creative Europe', 'EU', NULL, 'culture.ec.europa.eu', 'Creative Europe open calls culture media tourism grants Italy', 91, 'EU_PORTAL', 4),
  ('Italia Domani - bandi PNRR', 'NAZIONALE', NULL, 'italiadomani.gov.it', 'PNRR bandi avvisi amministrazioni titolari soggetti attuatori imprese aperto', 100, 'CATALOGO', 4),
  ('PA digitale 2026 - avvisi PNRR', 'NAZIONALE', NULL, 'padigitale2026.gov.it', 'avvisi PNRR digitale misure candidature fornitori imprese', 98, 'CATALOGO', 5),
  ('MIMIT - misure PNRR imprese', 'NAZIONALE', NULL, 'mimit.gov.it', 'PNRR missione componente investimento bando imprese fondo perduto domande', 99, 'DECRETO', 5),
  ('MASE - misure PNRR energia', 'NAZIONALE', NULL, 'mase.gov.it', 'PNRR avviso imprese energia rinnovabili economia circolare contributo', 98, 'DECRETO', 5),
  ('MUR - misure PNRR ricerca', 'NAZIONALE', NULL, 'mur.gov.it', 'PNRR avviso imprese ricerca innovazione partenariato bando', 97, 'DECRETO', 5),
  ('Ministero Turismo - PNRR', 'NAZIONALE', NULL, 'ministeroturismo.gov.it', 'PNRR avviso bando imprese turismo contributo fondo perduto', 96, 'DECRETO', 5)
ON CONFLICT (official_domain, search_query) DO UPDATE SET
  name = EXCLUDED.name,
  authority_level = EXCLUDED.authority_level,
  source_kind = EXCLUDED.source_kind,
  rarity_base = EXCLUDED.rarity_base,
  priority = EXCLUDED.priority,
  enabled = true,
  updated_at = now();

UPDATE public.trovabandi_sources
SET fast_lane = source_kind IN ('BUR', 'ALBO_PRETORIO', 'CAMERALE', 'GAL', 'DECRETO', 'EU_PORTAL'),
    scan_interval_minutes = CASE
      WHEN source_kind IN ('ALBO_PRETORIO', 'CAMERALE', 'GAL') THEN 30
      WHEN source_kind IN ('BUR', 'DECRETO', 'EU_PORTAL') THEN 60
      ELSE 360
    END,
    updated_at = now();

COMMENT ON COLUMN public.trovabandi_opportunities.pnrr_mission IS
  'PNRR mission identifier (for example M1), only when explicitly present in official evidence.';
COMMENT ON COLUMN public.trovabandi_opportunities.eligible_countries IS
  'Country codes/names explicitly admitted by the official call; empty means eligibility must be verified.';