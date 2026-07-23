-- 20260723220000_subito_composite_aliases_backfill.sql
--
-- CENTRAL CORE — Recupero sicuro etichette Subito composte.
--
-- Aggiunge alla mappa SQL public.civiko_quartiere_commercial_zone_map
-- SOLO gli alias composti Subito che soddisfano i quattro criteri:
--   1) la stringa composta viene solo VALIDATA per virgole (non split runtime);
--   2) ogni parte, normalizzata, esiste già in mappa;
--   3) nessuna parte sconosciuta;
--   4) tutte le parti puntano allo stesso identico commercial_zone_slug ufficiale.
--
-- Alias aggiunti (una volta): (già presenti nella mappa TS)
--   - 'zona industriale zip'            → est-forcellini-camin
--   - 'bassanello guizza voltabarozzo'  → sud-voltabarozzo-guizza  (idempotente)
--
-- Backfill: SOLO annunci fonte='subito', expired_at IS NULL, commercial_zone_slug IS NULL,
-- quartiere IS NULL. Join staging/listings SOLO tramite url esatto.
-- Il quartiere copiato deve essere una macro-etichetta di whitelist esplicita.
-- Il trigger civiko_padova_listings_zone_trg calcola commercial_zone_slug
-- esclusivamente tramite public.civiko_resolve_commercial_zone_slug(quartiere).
--
-- Preserva: prezzi, mq, url, agenzie, timestamp, expired_at, quartieri/slug già presenti.
--
-- Ridefinisce inoltre promote_padova_collect_v2_to_listings(timestamptz):
-- nel ramo non-Idealista, l'ON CONFLICT DO UPDATE riempie `quartiere`
-- SOLO se: quartiere esistente NULL, EXCLUDED.quartiere non NULL,
-- civiko_resolve_commercial_zone_slug(EXCLUDED.quartiere) ∈ 8 slug ufficiali.
-- Firma, SECURITY DEFINER, search_path, ACL, logica Idealista e struttura JSON invariati.

BEGIN;

-- Advisory lock (numero arbitrario dedicato a questa migration).
SELECT pg_advisory_xact_lock(772023220000);

-- ---------------------------------------------------------------------------
-- 1) Whitelist alias composti Subito da inserire nella mappa SQL.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _subito_alias_whitelist (
  quartiere_key text PRIMARY KEY,
  raw_label     text NOT NULL,
  slug          text NOT NULL
) ON COMMIT DROP;

INSERT INTO _subito_alias_whitelist(quartiere_key, raw_label, slug) VALUES
  ('bassanello guizza voltabarozzo', 'BASSANELLO, GUIZZA, VOLTABAROZZO', 'sud-voltabarozzo-guizza'),
  ('zona industriale zip',           'ZONA INDUSTRIALE,ZIP',             'est-forcellini-camin');

-- Guard: slug devono essere tra gli 8 ufficiali.
DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM _subito_alias_whitelist w
   WHERE w.slug NOT IN (
     SELECT DISTINCT commercial_zone_slug FROM public.civiko_quartiere_commercial_zone_map
   );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ABORT: whitelist contiene % slug fuori contratto', v_bad;
  END IF;
END $$;

-- Guard: la chiave normalizzata calcolata via civiko_normalize_quartiere sul raw_label
-- deve coincidere con la quartiere_key dichiarata. Fail-closed su discrepanza.
DO $$
DECLARE
  r record;
  v_norm text;
BEGIN
  FOR r IN SELECT quartiere_key, raw_label FROM _subito_alias_whitelist LOOP
    v_norm := public.civiko_normalize_quartiere(r.raw_label);
    IF v_norm IS DISTINCT FROM r.quartiere_key THEN
      RAISE EXCEPTION 'ABORT: normalize("%") = "%" ≠ whitelist key "%"',
        r.raw_label, v_norm, r.quartiere_key;
    END IF;
  END LOOP;
END $$;

-- Guard collisioni: se la chiave esiste già in mappa deve puntare allo stesso slug.
DO $$
DECLARE
  v_conflict int;
BEGIN
  SELECT count(*) INTO v_conflict
    FROM _subito_alias_whitelist w
    JOIN public.civiko_quartiere_commercial_zone_map m
      ON m.quartiere_key = w.quartiere_key
   WHERE m.commercial_zone_slug <> w.slug;
  IF v_conflict > 0 THEN
    RAISE EXCEPTION 'ABORT: collisione slug su % chiavi già presenti', v_conflict;
  END IF;
END $$;

-- Insert idempotente (chiavi già presenti sono no-op perché same-slug garantito sopra).
INSERT INTO public.civiko_quartiere_commercial_zone_map(quartiere_key, commercial_zone_slug)
SELECT quartiere_key, slug FROM _subito_alias_whitelist
ON CONFLICT (quartiere_key) DO NOTHING;

-- Verifica presenza finale.
DO $$
DECLARE
  v_missing int;
BEGIN
  SELECT count(*) INTO v_missing
    FROM _subito_alias_whitelist w
    LEFT JOIN public.civiko_quartiere_commercial_zone_map m
      ON m.quartiere_key = w.quartiere_key AND m.commercial_zone_slug = w.slug
   WHERE m.quartiere_key IS NULL;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'ABORT: % alias whitelist non risultano presenti dopo insert', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Backup protetto delle sole righe candidate al backfill.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.padova_listings_subito_alias_backfill_20260723 (
  id                    bigint PRIMARY KEY,
  url                   text NOT NULL,
  quartiere_before      text,
  commercial_zone_slug_before text,
  staging_quartiere     text,
  matched_alias         text NOT NULL,
  captured_at           timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.padova_listings_subito_alias_backfill_20260723 FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.padova_listings_subito_alias_backfill_20260723 TO service_role;
ALTER TABLE public.padova_listings_subito_alias_backfill_20260723 ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='padova_listings_subito_alias_backfill_20260723'
      AND policyname='service_role_only'
  ) THEN
    CREATE POLICY service_role_only
      ON public.padova_listings_subito_alias_backfill_20260723
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Popola backup delle righe che saranno effettivamente aggiornate.
WITH candidati AS (
  SELECT pl.id, pl.url, pl.quartiere AS quartiere_before,
         pl.commercial_zone_slug AS commercial_zone_slug_before,
         ci.quartiere AS staging_quartiere,
         w.raw_label AS matched_alias
    FROM public.padova_listings pl
    JOIN public.padova_collect_v2_items ci
      ON ci.url = pl.url AND ci.portal = 'subito'
    JOIN _subito_alias_whitelist w
      ON w.quartiere_key = public.civiko_normalize_quartiere(ci.quartiere)
   WHERE pl.fonte = 'subito'
     AND pl.expired_at IS NULL
     AND pl.commercial_zone_slug IS NULL
     AND pl.quartiere IS NULL
     AND ci.quartiere IS NOT NULL
)
INSERT INTO public.padova_listings_subito_alias_backfill_20260723
  (id, url, quartiere_before, commercial_zone_slug_before, staging_quartiere, matched_alias)
SELECT id, url, quartiere_before, commercial_zone_slug_before, staging_quartiere, matched_alias
FROM candidati
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3) Snapshot pre-backfill (per validazioni post).
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _pre_snapshot ON COMMIT DROP AS
SELECT
  count(*)                                                     AS totale,
  count(*) FILTER (WHERE commercial_zone_slug IS NOT NULL)     AS resolved,
  count(*) FILTER (WHERE commercial_zone_slug IS NULL)         AS unresolved
FROM public.padova_listings
WHERE fonte='subito' AND expired_at IS NULL;

CREATE TEMP TABLE _pre_resolved_ids ON COMMIT DROP AS
SELECT id, commercial_zone_slug, quartiere, prezzo, mq, url, agency, imported_at,
       last_seen_at, expired_at
FROM public.padova_listings
WHERE fonte='subito' AND expired_at IS NULL AND commercial_zone_slug IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4) Backfill effettivo: quartiere dallo staging solo per righe in backup.
--    Il trigger BEFORE UPDATE OF quartiere calcolerà commercial_zone_slug
--    esclusivamente via civiko_resolve_commercial_zone_slug(quartiere).
-- ---------------------------------------------------------------------------
UPDATE public.padova_listings pl
   SET quartiere = b.staging_quartiere
  FROM public.padova_listings_subito_alias_backfill_20260723 b
 WHERE pl.id = b.id
   AND pl.fonte = 'subito'
   AND pl.expired_at IS NULL
   AND pl.commercial_zone_slug IS NULL
   AND pl.quartiere IS NULL
   AND b.captured_at >= now() - interval '1 hour';

-- ---------------------------------------------------------------------------
-- 5) Validazioni bloccanti.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  pre RECORD;
  post_total int;
  post_resolved int;
  post_unresolved int;
  v_slug_out int;
  v_touched_pre_resolved int;
  v_bad_backfill int;
BEGIN
  SELECT * INTO pre FROM _pre_snapshot;

  SELECT
    count(*), count(*) FILTER (WHERE commercial_zone_slug IS NOT NULL),
    count(*) FILTER (WHERE commercial_zone_slug IS NULL)
    INTO post_total, post_resolved, post_unresolved
    FROM public.padova_listings
   WHERE fonte='subito' AND expired_at IS NULL;

  -- (a) totale invariato, nessuna creazione/eliminazione
  IF post_total <> pre.totale THEN
    RAISE EXCEPTION 'ABORT: totale Subito attivi cambiato (% -> %)', pre.totale, post_total;
  END IF;

  -- (b) resolved dopo >= resolved prima
  IF post_resolved < pre.resolved THEN
    RAISE EXCEPTION 'ABORT: resolved diminuiti (% -> %)', pre.resolved, post_resolved;
  END IF;

  -- (c) unresolved dopo <= unresolved prima
  IF post_unresolved > pre.unresolved THEN
    RAISE EXCEPTION 'ABORT: unresolved aumentati (% -> %)', pre.unresolved, post_unresolved;
  END IF;

  -- (d) tutte le nuove assegnazioni cadono negli 8 slug ufficiali
  SELECT count(*) INTO v_slug_out
    FROM public.padova_listings
   WHERE fonte='subito' AND expired_at IS NULL
     AND commercial_zone_slug IS NOT NULL
     AND commercial_zone_slug NOT IN (
       SELECT DISTINCT commercial_zone_slug FROM public.civiko_quartiere_commercial_zone_map
     );
  IF v_slug_out > 0 THEN
    RAISE EXCEPTION 'ABORT: % slug fuori contratto', v_slug_out;
  END IF;

  -- (e) nessuna riga già risolta è stata alterata (slug/quartiere/campi immutabili)
  SELECT count(*) INTO v_touched_pre_resolved
    FROM _pre_resolved_ids pre_r
    JOIN public.padova_listings pl ON pl.id = pre_r.id
   WHERE pl.commercial_zone_slug IS DISTINCT FROM pre_r.commercial_zone_slug
      OR pl.quartiere            IS DISTINCT FROM pre_r.quartiere
      OR pl.prezzo               IS DISTINCT FROM pre_r.prezzo
      OR pl.mq                   IS DISTINCT FROM pre_r.mq
      OR pl.url                  IS DISTINCT FROM pre_r.url
      OR pl.agency               IS DISTINCT FROM pre_r.agency
      OR pl.imported_at          IS DISTINCT FROM pre_r.imported_at
      OR pl.last_seen_at         IS DISTINCT FROM pre_r.last_seen_at
      OR pl.expired_at           IS DISTINCT FROM pre_r.expired_at;
  IF v_touched_pre_resolved > 0 THEN
    RAISE EXCEPTION 'ABORT: % righe già risolte sono state modificate', v_touched_pre_resolved;
  END IF;

  -- (f) tutte le righe backfillate hanno slug atteso == whitelist
  SELECT count(*) INTO v_bad_backfill
    FROM public.padova_listings_subito_alias_backfill_20260723 b
    JOIN public.padova_listings pl ON pl.id = b.id
    JOIN _subito_alias_whitelist w
      ON w.quartiere_key = public.civiko_normalize_quartiere(b.staging_quartiere)
   WHERE b.captured_at >= now() - interval '1 hour'
     AND (pl.commercial_zone_slug IS DISTINCT FROM w.slug
          OR pl.quartiere IS NULL);
  IF v_bad_backfill > 0 THEN
    RAISE EXCEPTION 'ABORT: % righe backfillate con slug/quartiere non atteso', v_bad_backfill;
  END IF;

  RAISE NOTICE 'OK subito backfill: pre resolved=% unresolved=% -> post resolved=% unresolved=%',
    pre.resolved, pre.unresolved, post_resolved, post_unresolved;
END $$;

-- ---------------------------------------------------------------------------
-- 6) Ridefinizione promote_padova_collect_v2_to_listings(timestamptz).
--    Firma, SECURITY DEFINER, search_path, struttura JSON invariati.
--    Branch non-Idealista: ON CONFLICT DO UPDATE riempie quartiere SOLO se
--    esistente NULL, EXCLUDED non NULL, resolver ∈ 8 slug ufficiali.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.promote_padova_collect_v2_to_listings(
  p_since timestamp with time zone DEFAULT (now() - '06:00:00'::interval)
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new int := 0;
  v_upd int := 0;
  v_idealista_new int := 0;
  v_idealista_updated int := 0;
  v_now timestamptz := now();
BEGIN
  -- Branch 1: non-idealista → UPSERT
  WITH src AS (
    SELECT DISTINCT ON (portal, url)
      portal, url, raw_address, agency, agency_phone,
      prezzo, mq, locali, bagni, lat, lng,
      CASE
        WHEN public.civiko_resolve_commercial_zone_slug(
               regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
             ) IS NULL
        THEN NULL
        ELSE regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
      END AS quartiere,
      raw_json
    FROM public.padova_collect_v2_items
    WHERE lower(coalesce(citta,'')) = 'padova'
      AND portal IS NOT NULL
      AND lower(portal) <> 'idealista'
      AND url IS NOT NULL
      AND updated_at >= p_since
      AND (prezzo IS NOT NULL OR mq IS NOT NULL)
    ORDER BY portal, url, updated_at DESC
  ),
  ups AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, telefono, tipo_lead, mq, locali, bagni, prezzo,
       lat, lng, indirizzo, quartiere, raw_json, imported_at, last_seen_at)
    SELECT
      s.portal, s.url, s.agency, s.agency_phone,
      'PRIVATO'::text,
      s.mq, s.locali, s.bagni,
      CASE WHEN s.prezzo IS NULL THEN NULL
           WHEN s.prezzo > 2147483647 THEN NULL
           ELSE s.prezzo::int END,
      s.lat, s.lng, s.raw_address, s.quartiere, s.raw_json, v_now, v_now
    FROM src s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency       = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      telefono     = COALESCE(EXCLUDED.telefono, public.padova_listings.telefono),
      tipo_lead    = COALESCE(EXCLUDED.tipo_lead, public.padova_listings.tipo_lead),
      mq           = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali       = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni        = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo       = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat          = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng          = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo    = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      -- Gate esplicito: riempie quartiere SOLO se esistente NULL,
      -- EXCLUDED non NULL, resolver ∈ 8 slug ufficiali.
      quartiere    = CASE
        WHEN public.padova_listings.quartiere IS NULL
         AND EXCLUDED.quartiere IS NOT NULL
         AND public.civiko_resolve_commercial_zone_slug(EXCLUDED.quartiere) IN (
               SELECT DISTINCT commercial_zone_slug FROM public.civiko_quartiere_commercial_zone_map
             )
        THEN EXCLUDED.quartiere
        ELSE public.padova_listings.quartiere
      END,
      raw_json     = COALESCE(EXCLUDED.raw_json, public.padova_listings.raw_json),
      last_seen_at = v_now,
      expired_at   = NULL
    WHERE (EXCLUDED.prezzo IS NOT NULL OR EXCLUDED.mq IS NOT NULL)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT
    count(*) FILTER (WHERE inserted),
    count(*) FILTER (WHERE NOT inserted)
  INTO v_new, v_upd
  FROM ups;

  -- Branch 2: idealista → invariato
  WITH src_id AS (
    SELECT DISTINCT ON (portal, url)
      portal, url, raw_address, agency, agency_phone,
      prezzo, mq, locali, bagni, lat, lng,
      CASE
        WHEN public.civiko_resolve_commercial_zone_slug(
               regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
             ) IS NULL
        THEN NULL
        ELSE regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
      END AS quartiere,
      raw_json
    FROM public.padova_collect_v2_items
    WHERE lower(coalesce(citta,'')) = 'padova'
      AND lower(portal) = 'idealista'
      AND url IS NOT NULL
      AND updated_at >= p_since
      AND (prezzo IS NOT NULL OR mq IS NOT NULL)
    ORDER BY portal, url, updated_at DESC
  ),
  ups_id AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, telefono, tipo_lead, mq, locali, bagni, prezzo,
       lat, lng, indirizzo, quartiere, raw_json, imported_at, last_seen_at)
    SELECT
      s.portal, s.url, s.agency, s.agency_phone,
      'PRIVATO'::text,
      s.mq, s.locali, s.bagni,
      CASE WHEN s.prezzo IS NULL THEN NULL
           WHEN s.prezzo > 2147483647 THEN NULL
           ELSE s.prezzo::int END,
      s.lat, s.lng, s.raw_address, s.quartiere, s.raw_json, v_now, v_now
    FROM src_id s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency       = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      telefono     = COALESCE(EXCLUDED.telefono, public.padova_listings.telefono),
      tipo_lead    = COALESCE(EXCLUDED.tipo_lead, public.padova_listings.tipo_lead),
      mq           = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali       = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni        = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo       = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat          = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng          = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo    = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      quartiere    = COALESCE(EXCLUDED.quartiere, public.padova_listings.quartiere),
      raw_json     = COALESCE(EXCLUDED.raw_json, public.padova_listings.raw_json),
      last_seen_at = v_now,
      expired_at   = NULL
    WHERE (EXCLUDED.prezzo IS NOT NULL OR EXCLUDED.mq IS NOT NULL)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT
    count(*) FILTER (WHERE inserted),
    count(*) FILTER (WHERE NOT inserted)
  INTO v_idealista_new, v_idealista_updated
  FROM ups_id;

  RETURN jsonb_build_object(
    'ok', true,
    'since', p_since,
    'new', v_new,
    'updated', v_upd,
    'idealista_new', v_idealista_new,
    'idealista_updated', v_idealista_updated
  );
END
$function$;

COMMIT;
