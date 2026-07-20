-- 20260720_verified_price_drops.sql
-- Migrazione NON applicata da questo file: il DB è stato aggiornato manualmente.
-- Questo file è mantenuto come sorgente di verità allineata alla versione live.
-- Idempotente.
--
-- Crea RPC public.get_padova_verified_price_drops(...) come unica fonte
-- autorevole dei ribassi Padova, calcolati SOLO da listing_price_snapshots.
--
-- Regole aste:
--  - confini di parola su asta/aste/auction/pvp/tribunale/pignoramento/
--    vendita giudiziaria/esecuzione immobiliare/procedura esecutiva
--  - domini noti (astalegale, asteimmobili, astegiudiziarie, ecc.)
--  - "catastale", "catasto", "visura catastale", "rendita catastale" NON sono aste
--  - "fallimentare" e "concordato preventivo" NON sono classificati automaticamente
--    come asta (troppi falsi positivi in listing commerciali)

BEGIN;

-- ── Indici prudenti, idempotenti ────────────────────────────
CREATE INDEX IF NOT EXISTS listing_price_snapshots_municipality_source_listing_captured_idx
  ON public.listing_price_snapshots (municipality, source, listing_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS listing_price_snapshots_municipality_source_url_captured_idx
  ON public.listing_price_snapshots (municipality, source, url, captured_at DESC);

CREATE INDEX IF NOT EXISTS padova_listings_url_idx
  ON public.padova_listings (url);

-- ── Helper immutable (interno, non esposto) ─────────────────
-- Riconosce se un blob testuale contiene segnali "asta" con confini di parola.
-- Prima neutralizza i falsi positivi (catastale, catasto, visura, rendita).
CREATE OR REPLACE FUNCTION public._is_auction_blob(_txt text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  WITH src AS (
    SELECT
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              lower(coalesce(_txt, '')),
              '(visur[ae]|rendit[ae])\s+catastal[ei]', ' catxx ', 'g'
            ),
            'catastal[ei]', ' catxx ', 'g'
          ),
          'catasto', ' catxx ', 'g'
        ),
        '[^a-z0-9./:-]+', ' ', 'g'
      ) AS t
  )
  SELECT EXISTS (
    SELECT 1 FROM src WHERE
      t ~ '(^|[^a-z0-9])(asta|aste|auction|pvp|tribunale|pignoramento|pignoramenti|vendita giudiziaria|vendite giudiziarie|esecuzione immobiliare|esecuzioni immobiliari|procedura esecutiva|procedure esecutive)([^a-z0-9]|$)'
      OR t LIKE '%astalegale.net%'
      OR t LIKE '%asteimmobili.it%'
      OR t LIKE '%astegiudiziarie%'
      OR t LIKE '%astetelematiche%'
      OR t LIKE '%portalevenditepubbliche%'
      OR t LIKE '%pvp.giustizia.it%'
      OR t LIKE '%spazioaste%'
      OR t LIKE '%gobid%'
      OR t LIKE '%garaimmobiliare%'
  );
$$;

REVOKE ALL ON FUNCTION public._is_auction_blob(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._is_auction_blob(text) TO service_role;

-- ── RPC pubblica (SECURITY DEFINER, ristretta a service_role) ─
-- LANGUAGE sql (non plpgsql) per allinearsi alla versione applicata al DB.
-- Alias univoci per tutte le colonne per evitare ambiguità con i nomi
-- delle colonne restituite (source, listing_id, url, ecc.).
CREATE OR REPLACE FUNCTION public.get_padova_verified_price_drops(
  p_limit integer DEFAULT 500,
  p_min_drop_pct numeric DEFAULT 5,
  p_max_age_days integer DEFAULT 14
)
RETURNS TABLE (
  source_id text,
  listing_id text,
  source text,
  url text,
  title text,
  mq numeric,
  lat double precision,
  lng double precision,
  initial_price_eur numeric,
  current_price_eur numeric,
  total_drop_pct numeric,
  drops_count integer,
  observations_count integer,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  comune text,
  omi_zone text,
  commercial_zone_slug text,
  zone_match_method text,
  zone_match_confidence numeric,
  raw_title text,
  raw_address text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH params AS (
    SELECT
      GREATEST(1, LEAST(coalesce(p_limit, 500), 1000))::integer          AS v_limit,
      GREATEST(1, LEAST(coalesce(p_min_drop_pct, 5), 60))::numeric        AS v_min_drop,
      GREATEST(1, LEAST(coalesce(p_max_age_days, 14), 90))::integer       AS v_max_age
  ),
  snap AS (
    SELECT
      s.source            AS s_source,
      s.listing_id        AS s_listing_id,
      s.url               AS s_url,
      s.municipality      AS s_municipality,
      s.captured_at       AS s_captured_at,
      s.price_eur         AS s_price_eur,
      s.raw_title         AS s_raw_title,
      s.raw_address       AS s_raw_address,
      s.id                AS s_id,
      CASE
        WHEN s.listing_id IS NOT NULL AND btrim(s.listing_id) <> ''
          THEN s.source || '::' || s.listing_id
        ELSE s.source || '::' || coalesce(s.url, '')
      END AS ident_key
    FROM public.listing_price_snapshots s
    WHERE lower(coalesce(s.municipality, '')) = 'padova'
      AND s.price_eur IS NOT NULL
      AND s.price_eur BETWEEN 10000 AND 5000000
      AND coalesce(s.url, '') LIKE 'https://%'
      AND NOT public._is_auction_blob(coalesce(s.url, '') || ' ' || coalesce(s.source, ''))
  ),
  agg AS (
    SELECT
      snap.ident_key                                                            AS a_ident_key,
      max(snap.s_source)                                                        AS a_source,
      max(snap.s_listing_id)                                                    AS a_listing_id,
      (array_agg(snap.s_url        ORDER BY snap.s_captured_at DESC, snap.s_id DESC))[1] AS a_url,
      (array_agg(snap.s_raw_title  ORDER BY snap.s_captured_at DESC, snap.s_id DESC))[1] AS a_raw_title,
      (array_agg(snap.s_raw_address ORDER BY snap.s_captured_at DESC, snap.s_id DESC))[1] AS a_raw_address,
      count(*)::integer                                                         AS a_observations_count,
      min(snap.s_captured_at)                                                   AS a_first_seen_at,
      max(snap.s_captured_at)                                                   AS a_last_seen_at,
      (array_agg(snap.s_price_eur  ORDER BY snap.s_captured_at ASC,  snap.s_id ASC))[1]  AS a_initial_price_eur,
      (array_agg(snap.s_price_eur  ORDER BY snap.s_captured_at DESC, snap.s_id DESC))[1] AS a_current_price_eur,
      array_agg(snap.s_price_eur   ORDER BY snap.s_captured_at ASC,  snap.s_id ASC)      AS a_prices_asc
    FROM snap
    GROUP BY snap.ident_key
  ),
  computed AS (
    SELECT
      agg.*,
      (
        SELECT count(*)::integer
        FROM (
          SELECT
            agg.a_prices_asc[i]   AS prev_p,
            agg.a_prices_asc[i+1] AS next_p
          FROM generate_subscripts(agg.a_prices_asc, 1) g(i)
          WHERE i < array_length(agg.a_prices_asc, 1)
        ) x
        WHERE x.prev_p IS NOT NULL AND x.next_p IS NOT NULL
          AND x.prev_p > 0
          AND ((x.prev_p - x.next_p) / x.prev_p) * 100 >= 1
      ) AS c_drops_count,
      CASE
        WHEN agg.a_initial_price_eur IS NULL OR agg.a_initial_price_eur <= 0 THEN 0::numeric
        ELSE round(((agg.a_initial_price_eur - agg.a_current_price_eur) / agg.a_initial_price_eur) * 100, 2)
      END AS c_total_drop_pct
    FROM agg
  ),
  filtered AS (
    SELECT c.*
    FROM computed c, params
    WHERE c.a_observations_count >= 2
      AND c.a_initial_price_eur IS NOT NULL
      AND c.a_current_price_eur IS NOT NULL
      AND c.a_current_price_eur < c.a_initial_price_eur
      AND c.a_last_seen_at >= (now() - make_interval(days => params.v_max_age))
      AND (extract(epoch FROM (c.a_last_seen_at - c.a_first_seen_at)) / 3600.0) >= 6
      AND c.c_total_drop_pct >= params.v_min_drop
  ),
  joined AS (
    SELECT
      f.*,
      pl.id                     AS pl_id,
      pl.mq                     AS pl_mq,
      pl.lat                    AS pl_lat,
      pl.lng                    AS pl_lng,
      pl.indirizzo              AS pl_indirizzo,
      pl.comune                 AS pl_comune,
      pl.expired_at             AS pl_expired_at,
      pl.commercial_zone_slug   AS pl_zone_slug,
      pl.omi_zone               AS pl_omi_zone,
      pl.zone_match_method      AS pl_zmm,
      pl.zone_match_confidence  AS pl_zmc,
      pl.raw_json               AS pl_raw_json
    FROM filtered f
    LEFT JOIN LATERAL (
      SELECT p.*
      FROM public.padova_listings p
      WHERE p.url = f.a_url
      ORDER BY p.last_seen_at DESC NULLS LAST, p.id DESC
      LIMIT 1
    ) pl ON true
  )
  SELECT
    j.a_ident_key                                                              AS source_id,
    j.a_listing_id                                                             AS listing_id,
    j.a_source                                                                 AS source,
    j.a_url                                                                    AS url,
    coalesce(
      nullif(btrim(j.pl_indirizzo), ''),
      nullif(btrim(j.a_raw_title), ''),
      nullif(btrim(j.a_raw_address), ''),
      j.a_source || ' ' || coalesce(j.a_listing_id, '')
    )                                                                          AS title,
    j.pl_mq                                                                    AS mq,
    j.pl_lat                                                                   AS lat,
    j.pl_lng                                                                   AS lng,
    j.a_initial_price_eur                                                      AS initial_price_eur,
    j.a_current_price_eur                                                      AS current_price_eur,
    j.c_total_drop_pct                                                         AS total_drop_pct,
    j.c_drops_count                                                            AS drops_count,
    j.a_observations_count                                                     AS observations_count,
    j.a_first_seen_at                                                          AS first_seen_at,
    j.a_last_seen_at                                                           AS last_seen_at,
    j.pl_comune                                                                AS comune,
    j.pl_omi_zone                                                              AS omi_zone,
    j.pl_zone_slug                                                             AS commercial_zone_slug,
    j.pl_zmm                                                                   AS zone_match_method,
    j.pl_zmc                                                                   AS zone_match_confidence,
    j.a_raw_title                                                              AS raw_title,
    j.a_raw_address                                                            AS raw_address
  FROM joined j, params
  WHERE j.pl_id IS NOT NULL
    AND j.pl_expired_at IS NULL
    AND lower(coalesce(j.pl_comune, '')) = 'padova'
    AND j.pl_zone_slug IS NOT NULL
    AND btrim(j.pl_zone_slug) <> ''
    AND NOT public._is_auction_blob(
      coalesce(j.a_url, '')          || ' ' ||
      coalesce(j.pl_indirizzo, '')   || ' ' ||
      coalesce(j.a_raw_title, '')    || ' ' ||
      coalesce(j.a_raw_address, '')  || ' ' ||
      coalesce(j.a_source, '')       || ' ' ||
      coalesce(j.pl_raw_json::text, '')
    )
  ORDER BY j.c_total_drop_pct DESC, j.a_last_seen_at DESC
  LIMIT (SELECT v_limit FROM params);
$$;

REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops(integer, numeric, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops(integer, numeric, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops(integer, numeric, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_padova_verified_price_drops(integer, numeric, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_padova_verified_price_drops(integer, numeric, integer) TO postgres;

COMMIT;
