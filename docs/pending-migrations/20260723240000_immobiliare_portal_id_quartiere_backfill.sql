-- Central Core — Immobiliare deterministic portal-ID quartiere backfill.
-- Identity: padova_immobiliare_detail_staging.raw_json->>'id' (structured portal ID)
--           matched 1:1 against substring(padova_listings.url from '/annunci/(\d+)').
-- Fonte target: immobiliare (attivi non risolti).
-- Nessuna sovrascrittura di quartieri già valorizzati; nessuna modifica agli URL,
-- prezzo, mq, agency, telefono, coordinate, timestamp, expired_at.
-- Slug derivato esclusivamente dal resolver quartiere-only.

BEGIN;

SELECT pg_advisory_xact_lock(772023240000);

-- 1. Corrispondenze 1:1 candidate.
CREATE TEMP TABLE tmp_imm_pairs ON COMMIT DROP AS
WITH listings AS (
  SELECT id AS listing_id,
         url,
         substring(url from '/annunci/(\d+)') AS pid
  FROM public.padova_listings
  WHERE fonte = 'immobiliare'
    AND expired_at IS NULL
    AND (commercial_zone_slug IS NULL OR commercial_zone_slug = 'UNRESOLVED')
    AND nullif(trim(coalesce(quartiere, '')), '') IS NULL
),
stag_distinct AS (
  SELECT DISTINCT
         (raw_json->>'id')                                 AS pid,
         raw_json->'geography'->'microzone'->>'name'       AS microzone
  FROM public.padova_immobiliare_detail_staging
  WHERE raw_json ? 'id'
    AND raw_json->'geography'->'microzone'->>'name' IS NOT NULL
),
-- Escludi PID staging con microzone divergenti (ambiguità)
stag_unique AS (
  SELECT pid, MAX(microzone) AS microzone
  FROM stag_distinct
  GROUP BY pid
  HAVING COUNT(DISTINCT microzone) = 1
)
SELECT l.listing_id, l.url, l.pid, s.microzone
FROM listings l
JOIN stag_unique s ON s.pid = l.pid
WHERE l.pid IS NOT NULL
  AND public.civiko_resolve_commercial_zone_slug(s.microzone) IN (
        SELECT slug FROM public.civiko_commercial_zones);

-- 2. Controlli bloccanti di unicità (rollback se violati).
DO $$
DECLARE
  v_listing_dup int;
  v_pid_dup int;
BEGIN
  SELECT COUNT(*) INTO v_listing_dup
  FROM (SELECT listing_id FROM tmp_imm_pairs GROUP BY listing_id HAVING COUNT(*) > 1) x;
  IF v_listing_dup > 0 THEN
    RAISE EXCEPTION 'listing_id collisions: %', v_listing_dup;
  END IF;

  SELECT COUNT(*) INTO v_pid_dup
  FROM (SELECT pid FROM tmp_imm_pairs GROUP BY pid HAVING COUNT(*) > 1) x;
  IF v_pid_dup > 0 THEN
    RAISE EXCEPTION 'portal_id collisions: %', v_pid_dup;
  END IF;
END $$;

-- 3. Backup service_role-only delle sole righe candidate.
CREATE TABLE IF NOT EXISTS public.padova_listings_immobiliare_quartiere_backfill_20260723 (
  listing_id bigint PRIMARY KEY,
  url text NOT NULL,
  portal_id text NOT NULL,
  quartiere_before text,
  commercial_zone_slug_before text,
  quartiere_after text NOT NULL,
  backfilled_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.padova_listings_immobiliare_quartiere_backfill_20260723
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.padova_listings_immobiliare_quartiere_backfill_20260723 FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.padova_listings_immobiliare_quartiere_backfill_20260723 TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename='padova_listings_immobiliare_quartiere_backfill_20260723'
      AND policyname='service_role_all_imm_backfill_20260723'
  ) THEN
    CREATE POLICY service_role_all_imm_backfill_20260723
      ON public.padova_listings_immobiliare_quartiere_backfill_20260723
      TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

INSERT INTO public.padova_listings_immobiliare_quartiere_backfill_20260723
  (listing_id, url, portal_id, quartiere_before, commercial_zone_slug_before, quartiere_after)
SELECT l.id, l.url, p.pid, l.quartiere, l.commercial_zone_slug, p.microzone
FROM tmp_imm_pairs p
JOIN public.padova_listings l ON l.id = p.listing_id
ON CONFLICT (listing_id) DO NOTHING;

-- 4. Snapshot pre-update.
DO $$
DECLARE
  v_total_before int;
  v_resolved_before int;
  v_unresolved_before int;
BEGIN
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE commercial_zone_slug IS NOT NULL AND commercial_zone_slug <> 'UNRESOLVED'),
         COUNT(*) FILTER (WHERE commercial_zone_slug IS NULL OR commercial_zone_slug = 'UNRESOLVED')
    INTO v_total_before, v_resolved_before, v_unresolved_before
  FROM public.padova_listings WHERE fonte='immobiliare' AND expired_at IS NULL;
  PERFORM set_config('civiko.imm_total_before', v_total_before::text, true);
  PERFORM set_config('civiko.imm_resolved_before', v_resolved_before::text, true);
  PERFORM set_config('civiko.imm_unresolved_before', v_unresolved_before::text, true);
END $$;

-- 5. Backfill: solo quartiere. Lo slug e' derivato dal trigger via resolver.
WITH upd AS (
  UPDATE public.padova_listings l
  SET quartiere = p.microzone
  FROM tmp_imm_pairs p
  WHERE l.id = p.listing_id
    AND l.fonte = 'immobiliare'
    AND l.expired_at IS NULL
    AND nullif(trim(coalesce(l.quartiere, '')), '') IS NULL
    AND (l.commercial_zone_slug IS NULL OR l.commercial_zone_slug = 'UNRESOLVED')
  RETURNING l.id
)
SELECT set_config('civiko.imm_backfilled', COUNT(*)::text, true) FROM upd;

-- 6. Validazioni bloccanti post-update.
DO $$
DECLARE
  v_total_after int;
  v_resolved_after int;
  v_unresolved_after int;
  v_out_of_contract int;
  v_touched_other int;
BEGIN
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE commercial_zone_slug IS NOT NULL AND commercial_zone_slug <> 'UNRESOLVED'),
         COUNT(*) FILTER (WHERE commercial_zone_slug IS NULL OR commercial_zone_slug = 'UNRESOLVED')
    INTO v_total_after, v_resolved_after, v_unresolved_after
  FROM public.padova_listings WHERE fonte='immobiliare' AND expired_at IS NULL;

  IF v_total_after <> current_setting('civiko.imm_total_before')::int THEN
    RAISE EXCEPTION 'total invariance broken: % -> %', current_setting('civiko.imm_total_before'), v_total_after;
  END IF;
  IF v_resolved_after < current_setting('civiko.imm_resolved_before')::int THEN
    RAISE EXCEPTION 'resolved decreased';
  END IF;
  IF v_unresolved_after > current_setting('civiko.imm_unresolved_before')::int THEN
    RAISE EXCEPTION 'unresolved increased';
  END IF;

  -- Ogni riga backfillata: quartiere non nullo E slug in contratto.
  SELECT COUNT(*) INTO v_out_of_contract
  FROM public.padova_listings_immobiliare_quartiere_backfill_20260723 b
  JOIN public.padova_listings l ON l.id = b.listing_id
  WHERE nullif(trim(coalesce(l.quartiere,'')),'') IS NULL
     OR l.commercial_zone_slug NOT IN (SELECT slug FROM public.civiko_commercial_zones);
  IF v_out_of_contract > 0 THEN
    RAISE EXCEPTION 'rows out of contract post-backfill: %', v_out_of_contract;
  END IF;

  -- Nessuna riga di altra fonte modificata.
  SELECT COUNT(*) INTO v_touched_other
  FROM public.padova_listings_immobiliare_quartiere_backfill_20260723 b
  JOIN public.padova_listings l ON l.id = b.listing_id
  WHERE l.fonte <> 'immobiliare';
  IF v_touched_other > 0 THEN
    RAISE EXCEPTION 'other-fonte rows touched: %', v_touched_other;
  END IF;
END $$;

COMMIT;
