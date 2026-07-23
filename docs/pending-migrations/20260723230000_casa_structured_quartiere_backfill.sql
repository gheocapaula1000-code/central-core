-- 20260723230000_casa_structured_quartiere_backfill.sql
-- Central Core — recover the largest cohort of casa (idealista.it/case) listings
-- whose commercial zone is currently UNRESOLVED but whose structured quartiere
-- field in padova_collect_v2_items resolves to one of the 8 official slugs.
--
-- Runtime path corrected (public.promote_padova_collect_v2_to_listings):
--   * non-idealista branch now treats an existing empty/whitespace quartiere
--     as NULL, so future promotions can fill it from the structured column
--     without ever overwriting an existing valid quartiere / official zone.
--   * still uses ONLY the structured `quartiere` column (never raw_json /
--     title / description / geocode / CAP / OMI / coordinates).
--   * commercial_zone_slug is produced exclusively by
--     public.civiko_padova_listings_zone_trg -> civiko_resolve_commercial_zone_slug
--     (quartiere-only resolver, no fallback).
--
-- Backfill: one-shot UPDATE on currently unresolved active `casa` listings,
-- joined by exact URL to padova_collect_v2_items (portal='casa'), copying
-- only the structured quartiere. The BEFORE trigger populates the slug.
--
-- Safety: single BEGIN/COMMIT, advisory lock, service_role-only backup
-- of the exact candidate rows, blocking post-conditions with rollback on any
-- deviation. No changes to prezzo, mq, url, agency, last_seen_at, expired_at,
-- imported_at, raw_json, or to any other fonte (subito/immobiliare/idealista).

BEGIN;

SELECT pg_advisory_xact_lock(772023230000);

-- ---------------------------------------------------------------------------
-- 1. Baseline snapshot
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_total_pre int;
  v_resolved_pre int;
  v_unresolved_pre int;
  v_casa_total_pre int;
  v_casa_resolved_pre int;
  v_casa_unresolved_pre int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE commercial_zone_slug IS NOT NULL AND commercial_zone_slug <> 'UNRESOLVED'),
         count(*) FILTER (WHERE commercial_zone_slug IS NULL OR commercial_zone_slug = 'UNRESOLVED')
    INTO v_total_pre, v_resolved_pre, v_unresolved_pre
    FROM public.padova_listings
   WHERE expired_at IS NULL;

  SELECT count(*),
         count(*) FILTER (WHERE commercial_zone_slug IS NOT NULL AND commercial_zone_slug <> 'UNRESOLVED'),
         count(*) FILTER (WHERE commercial_zone_slug IS NULL OR commercial_zone_slug = 'UNRESOLVED')
    INTO v_casa_total_pre, v_casa_resolved_pre, v_casa_unresolved_pre
    FROM public.padova_listings
   WHERE expired_at IS NULL AND fonte = 'casa';

  PERFORM set_config('civiko.backfill_casa.total_pre',      v_total_pre::text,      true);
  PERFORM set_config('civiko.backfill_casa.resolved_pre',   v_resolved_pre::text,   true);
  PERFORM set_config('civiko.backfill_casa.unresolved_pre', v_unresolved_pre::text, true);
  PERFORM set_config('civiko.backfill_casa.casa_total_pre',      v_casa_total_pre::text,      true);
  PERFORM set_config('civiko.backfill_casa.casa_resolved_pre',   v_casa_resolved_pre::text,   true);
  PERFORM set_config('civiko.backfill_casa.casa_unresolved_pre', v_casa_unresolved_pre::text, true);

  RAISE NOTICE 'PRE  active_total=% resolved=% unresolved=% | casa total=% resolved=% unresolved=%',
    v_total_pre, v_resolved_pre, v_unresolved_pre,
    v_casa_total_pre, v_casa_resolved_pre, v_casa_unresolved_pre;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Backup of the exact candidate cohort (service_role only)
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS public.padova_listings_casa_quartiere_backfill_20260723;
CREATE TABLE public.padova_listings_casa_quartiere_backfill_20260723 AS
SELECT l.id,
       l.url,
       l.fonte,
       l.quartiere            AS quartiere_pre,
       l.commercial_zone_slug AS commercial_zone_slug_pre,
       s.quartiere            AS quartiere_structured,
       public.civiko_resolve_commercial_zone_slug(s.quartiere) AS resolved_slug,
       now()                  AS captured_at
  FROM public.padova_listings l
  JOIN public.padova_collect_v2_items s
    ON s.url = l.url
   AND lower(s.portal) = 'casa'
 WHERE l.expired_at IS NULL
   AND l.fonte = 'casa'
   AND (l.commercial_zone_slug IS NULL OR l.commercial_zone_slug = 'UNRESOLVED')
   AND nullif(trim(coalesce(l.quartiere, '')), '') IS NULL
   AND public.civiko_resolve_commercial_zone_slug(s.quartiere) IS NOT NULL;

ALTER TABLE public.padova_listings_casa_quartiere_backfill_20260723 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.padova_listings_casa_quartiere_backfill_20260723 FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.padova_listings_casa_quartiere_backfill_20260723 TO service_role;

-- Assert every backup candidate resolves to one of the 8 official slugs.
DO $$
DECLARE
  v_cnt int;
  v_bad int;
BEGIN
  SELECT count(*) INTO v_cnt
    FROM public.padova_listings_casa_quartiere_backfill_20260723;

  SELECT count(*) INTO v_bad
    FROM public.padova_listings_casa_quartiere_backfill_20260723 b
   WHERE b.resolved_slug NOT IN (
           SELECT slug FROM public.civiko_commercial_zones
         );

  PERFORM set_config('civiko.backfill_casa.candidates', v_cnt::text, true);

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'BACKFILL_ABORT: % candidate(s) resolve to slugs outside the 8-zone contract', v_bad;
  END IF;

  RAISE NOTICE 'CANDIDATES casa=%', v_cnt;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Runtime path: harden non-idealista branch of the promote RPC.
--    - Only the OVERWRITE guard changes: treat an empty/whitespace quartiere
--      as NULL so future promotions can fill it from the structured column.
--    - Never overwrites an existing non-empty quartiere or an already-set
--      official zone.
--    - Still uses ONLY the structured `padova_collect_v2_items.quartiere`.
--    - commercial_zone_slug is produced exclusively via the BEFORE trigger
--      that calls civiko_resolve_commercial_zone_slug (quartiere-only).
--    - Signature, SECURITY DEFINER, search_path, ACL and returned JSON
--      preserved verbatim; idealista branch untouched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.promote_padova_collect_v2_to_listings(
  p_since timestamp with time zone DEFAULT (now() - interval '06:00:00')
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_new int := 0; v_upd int := 0;
  v_idealista_new int := 0; v_idealista_updated int := 0;
  v_now timestamptz := now();
BEGIN
  WITH src AS (
    SELECT DISTINCT ON (portal, url)
      portal, url, raw_address, agency, agency_phone,
      prezzo, mq, locali, bagni, lat, lng,
      CASE WHEN public.civiko_resolve_commercial_zone_slug(
             regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')) IS NULL
        THEN NULL
        ELSE regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
      END AS quartiere,
      raw_json
    FROM public.padova_collect_v2_items
    WHERE lower(coalesce(citta,'')) = 'padova'
      AND portal IS NOT NULL AND lower(portal) <> 'idealista'
      AND url IS NOT NULL AND updated_at >= p_since
      AND (prezzo IS NOT NULL OR mq IS NOT NULL)
    ORDER BY portal, url, updated_at DESC
  ),
  ups AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, telefono, tipo_lead, mq, locali, bagni, prezzo,
       lat, lng, indirizzo, quartiere, raw_json, imported_at, last_seen_at)
    SELECT s.portal, s.url, s.agency, s.agency_phone, 'PRIVATO'::text,
      s.mq, s.locali, s.bagni,
      CASE WHEN s.prezzo IS NULL THEN NULL WHEN s.prezzo > 2147483647 THEN NULL ELSE s.prezzo::int END,
      s.lat, s.lng, s.raw_address, s.quartiere, s.raw_json, v_now, v_now
    FROM src s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      telefono = COALESCE(EXCLUDED.telefono, public.padova_listings.telefono),
      tipo_lead = COALESCE(EXCLUDED.tipo_lead, public.padova_listings.tipo_lead),
      mq = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      quartiere = CASE
        -- Fill only when the destination is NULL or blank AND the source
        -- structured quartiere resolves to one of the 8 official slugs.
        WHEN nullif(trim(coalesce(public.padova_listings.quartiere, '')), '') IS NULL
         AND EXCLUDED.quartiere IS NOT NULL
         AND public.civiko_resolve_commercial_zone_slug(EXCLUDED.quartiere) IN (
               SELECT slug FROM public.civiko_commercial_zones)
        THEN EXCLUDED.quartiere
        ELSE public.padova_listings.quartiere
      END,
      raw_json = COALESCE(EXCLUDED.raw_json, public.padova_listings.raw_json),
      last_seen_at = v_now,
      expired_at = NULL
    WHERE (EXCLUDED.prezzo IS NOT NULL OR EXCLUDED.mq IS NOT NULL)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
  INTO v_new, v_upd FROM ups;

  WITH src_id AS (
    SELECT DISTINCT ON (portal, url)
      portal, url, raw_address, agency, agency_phone,
      prezzo, mq, locali, bagni, lat, lng,
      CASE WHEN public.civiko_resolve_commercial_zone_slug(
             regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')) IS NULL
        THEN NULL
        ELSE regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
      END AS quartiere,
      raw_json
    FROM public.padova_collect_v2_items
    WHERE lower(coalesce(citta,'')) = 'padova'
      AND lower(portal) = 'idealista' AND url IS NOT NULL AND updated_at >= p_since
      AND (prezzo IS NOT NULL OR mq IS NOT NULL)
    ORDER BY portal, url, updated_at DESC
  ),
  ups_id AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, telefono, tipo_lead, mq, locali, bagni, prezzo,
       lat, lng, indirizzo, quartiere, raw_json, imported_at, last_seen_at)
    SELECT s.portal, s.url, s.agency, s.agency_phone, 'PRIVATO'::text,
      s.mq, s.locali, s.bagni,
      CASE WHEN s.prezzo IS NULL THEN NULL WHEN s.prezzo > 2147483647 THEN NULL ELSE s.prezzo::int END,
      s.lat, s.lng, s.raw_address, s.quartiere, s.raw_json, v_now, v_now
    FROM src_id s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      telefono = COALESCE(EXCLUDED.telefono, public.padova_listings.telefono),
      tipo_lead = COALESCE(EXCLUDED.tipo_lead, public.padova_listings.tipo_lead),
      mq = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      quartiere = COALESCE(EXCLUDED.quartiere, public.padova_listings.quartiere),
      raw_json = COALESCE(EXCLUDED.raw_json, public.padova_listings.raw_json),
      last_seen_at = v_now,
      expired_at = NULL
    WHERE (EXCLUDED.prezzo IS NOT NULL OR EXCLUDED.mq IS NOT NULL)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
  INTO v_idealista_new, v_idealista_updated FROM ups_id;

  RETURN jsonb_build_object(
    'ok', true, 'since', p_since,
    'new', v_new, 'updated', v_upd,
    'idealista_new', v_idealista_new,
    'idealista_updated', v_idealista_updated
  );
END
$function$;

-- ---------------------------------------------------------------------------
-- 4. Backfill: copy structured quartiere for the exact backup cohort.
--    Trigger civiko_padova_listings_zone_trg (BEFORE UPDATE OF quartiere)
--    populates commercial_zone_slug via the quartiere-only resolver.
--    Only `quartiere` is written; no other columns are touched.
-- ---------------------------------------------------------------------------
WITH upd AS (
  UPDATE public.padova_listings l
     SET quartiere = b.quartiere_structured
    FROM public.padova_listings_casa_quartiere_backfill_20260723 b
   WHERE l.id = b.id
     AND l.expired_at IS NULL
     AND l.fonte = 'casa'
     AND (l.commercial_zone_slug IS NULL OR l.commercial_zone_slug = 'UNRESOLVED')
     AND nullif(trim(coalesce(l.quartiere, '')), '') IS NULL
  RETURNING l.id
)
SELECT set_config('civiko.backfill_casa.updated',
                  (SELECT count(*)::text FROM upd), true);

-- ---------------------------------------------------------------------------
-- 5. Blocking post-conditions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_total_pre        int := current_setting('civiko.backfill_casa.total_pre')::int;
  v_resolved_pre     int := current_setting('civiko.backfill_casa.resolved_pre')::int;
  v_unresolved_pre   int := current_setting('civiko.backfill_casa.unresolved_pre')::int;
  v_candidates       int := current_setting('civiko.backfill_casa.candidates')::int;
  v_updated          int := current_setting('civiko.backfill_casa.updated')::int;

  v_total_post       int;
  v_resolved_post    int;
  v_unresolved_post  int;

  v_other_changed    int;
  v_bad_slug         int;
  v_no_quartiere     int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE commercial_zone_slug IS NOT NULL AND commercial_zone_slug <> 'UNRESOLVED'),
         count(*) FILTER (WHERE commercial_zone_slug IS NULL OR commercial_zone_slug = 'UNRESOLVED')
    INTO v_total_post, v_resolved_post, v_unresolved_post
    FROM public.padova_listings
   WHERE expired_at IS NULL;

  IF v_total_post <> v_total_pre THEN
    RAISE EXCEPTION 'ROLLBACK: active row count changed pre=% post=%', v_total_pre, v_total_post;
  END IF;

  IF v_resolved_post < v_resolved_pre THEN
    RAISE EXCEPTION 'ROLLBACK: resolved decreased pre=% post=%', v_resolved_pre, v_resolved_post;
  END IF;

  IF v_unresolved_post > v_unresolved_pre THEN
    RAISE EXCEPTION 'ROLLBACK: unresolved increased pre=% post=%', v_unresolved_pre, v_unresolved_post;
  END IF;

  IF v_updated <> v_candidates THEN
    RAISE EXCEPTION 'ROLLBACK: updated=% but candidates=%', v_updated, v_candidates;
  END IF;

  -- No changes to any other fonte
  SELECT count(*) INTO v_other_changed
    FROM public.padova_listings l
   WHERE l.fonte <> 'casa'
     AND l.id IN (SELECT id FROM public.padova_listings_casa_quartiere_backfill_20260723);

  IF v_other_changed > 0 THEN
    RAISE EXCEPTION 'ROLLBACK: backup cohort contains non-casa rows: %', v_other_changed;
  END IF;

  -- Every updated row must now carry an official slug
  SELECT count(*) INTO v_bad_slug
    FROM public.padova_listings l
    JOIN public.padova_listings_casa_quartiere_backfill_20260723 b ON b.id = l.id
   WHERE l.commercial_zone_slug IS NULL
      OR l.commercial_zone_slug NOT IN (SELECT slug FROM public.civiko_commercial_zones);

  IF v_bad_slug > 0 THEN
    RAISE EXCEPTION 'ROLLBACK: % backfilled row(s) missing official slug', v_bad_slug;
  END IF;

  -- Every updated row must now carry a non-empty quartiere sourced from staging
  SELECT count(*) INTO v_no_quartiere
    FROM public.padova_listings l
    JOIN public.padova_listings_casa_quartiere_backfill_20260723 b ON b.id = l.id
   WHERE nullif(trim(coalesce(l.quartiere,'')),'') IS NULL
      OR l.quartiere IS DISTINCT FROM b.quartiere_structured;

  IF v_no_quartiere > 0 THEN
    RAISE EXCEPTION 'ROLLBACK: % backfilled row(s) missing structured quartiere', v_no_quartiere;
  END IF;

  RAISE NOTICE 'POST active_total=% resolved=% unresolved=% | candidates=% updated=%',
    v_total_post, v_resolved_post, v_unresolved_post, v_candidates, v_updated;
END $$;

COMMIT;
