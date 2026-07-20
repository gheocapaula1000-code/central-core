-- 20260720_padova_private_leads_zones.sql
--
-- Aggiunge alla tabella public.padova_listings i campi necessari per:
--   - distinguere i lead del Comune di Padova dal resto della provincia
--   - assegnare una zona commerciale reale (civiko_commercial_zones)
--   - tracciare metodo e confidenza della zonizzazione
--
-- Migrazione idempotente. NON viene applicata automaticamente.
-- Nessuna riga viene cancellata: si preservano tutti i lead provinciali.

BEGIN;

-- 1) Colonne (idempotenti) ---------------------------------------------------
ALTER TABLE public.padova_listings
  ADD COLUMN IF NOT EXISTS comune                  text,
  ADD COLUMN IF NOT EXISTS omi_zone                text,
  ADD COLUMN IF NOT EXISTS commercial_zone_slug    text,
  ADD COLUMN IF NOT EXISTS zone_match_method       text,
  ADD COLUMN IF NOT EXISTS zone_match_confidence   numeric,
  ADD COLUMN IF NOT EXISTS zone_resolved_at        timestamptz;

-- 2) Constraint CHECK sulla confidenza (0..1 oppure NULL) --------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'padova_listings_zone_match_confidence_chk'
  ) THEN
    ALTER TABLE public.padova_listings
      ADD CONSTRAINT padova_listings_zone_match_confidence_chk
      CHECK (
        zone_match_confidence IS NULL
        OR (zone_match_confidence >= 0 AND zone_match_confidence <= 1)
      );
  END IF;
END $$;

-- 3) Foreign key nullable verso civiko_commercial_zones(slug) ----------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'padova_listings_commercial_zone_slug_fkey'
  ) THEN
    ALTER TABLE public.padova_listings
      ADD CONSTRAINT padova_listings_commercial_zone_slug_fkey
      FOREIGN KEY (commercial_zone_slug)
      REFERENCES public.civiko_commercial_zones(slug)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

-- 4) Indici ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS padova_listings_comune_tipo_lead_idx
  ON public.padova_listings (comune, tipo_lead);

CREATE INDEX IF NOT EXISTS padova_listings_commercial_zone_slug_priv_idx
  ON public.padova_listings (commercial_zone_slug)
  WHERE tipo_lead IN ('PRIVATO','privato','privato_stanco');

-- 5) Backfill prudente -------------------------------------------------------
-- 5a) Subito: comune ricavato da raw_json->>'geo_town_value'.
UPDATE public.padova_listings
   SET comune = NULLIF(btrim(raw_json->>'geo_town_value'), '')
 WHERE fonte = 'subito'
   AND comune IS NULL
   AND raw_json ? 'geo_town_value';

-- 5b) Fonti diverse da Subito: la pipeline attuale raccoglie SOLO Padova città
--     (immobiliare/idealista/casa/subito_full sono già filtrati a monte),
--     quindi impostiamo comune='Padova' SOLO quando è NULL.
UPDATE public.padova_listings
   SET comune = 'Padova'
 WHERE fonte <> 'subito'
   AND comune IS NULL;

-- NB: non popoliamo commercial_zone_slug / omi_zone in SQL: la zonizzazione
--     avviene lato edge function con evidenza geografica reale.

COMMIT;
