-- 20260720_verified_price_drops.sql
-- Migrazione NON applicata. Idempotente.
-- Crea RPC public.get_padova_verified_price_drops(...) come unica fonte
-- autorevole dei ribassi Padova, calcolati SOLO da listing_price_snapshots.
--
-- La logica di esclusione aste usa confini di parola e NON classifica
-- "catastale/catasto/visura catastale/rendita catastale" come asta.

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
      t ~ '(^|[^a-z0-9])(asta|aste|auction|pvp|tribunale|pignoramento|pignoramenti|vendita giudiziaria|vendite giudiziarie|esecuzione immobiliare|esecuzioni immobiliari|procedura esecutiva|procedure esecutive|fallimentare|concordato preventivo)([^a-z0-9]|$)'
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
  zone_match_confidence numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := GREATEST(1, LEAST(coalesce(p_limit, 500), 1000));
  v_min_drop numeric := GREATEST(1, LEAST(coalesce(p_min_drop_pct, 5), 60));
  v_max_age integer := GREATEST(1, LEAST(coalesce(p_max_age_days, 14), 90));
  v_max_age_cutoff timestamptz := now() - make_interval(days => v_max_age);
BEGIN
  RETURN QUERY
  WITH snap AS (
    SELECT
      s.source,
      s.listing_id,
      s.url,
      s.municipality,
      s.captured_at,
      s.price_eur,
      -- identità per singolo annuncio: (source, listing_id) oppure (source, url) come fallback
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
      ident_key,
      max(source) AS source,
      max(listing_id) AS listing_id,
      (array_agg(url ORDER BY captured_at DESC))[1] AS url,
      count(*)::integer AS observations_count,
      min(captured_at) AS first_seen_at,
      max(captured_at) AS last_seen_at,
      (array_agg(price_eur ORDER BY captured_at ASC))[1] AS initial_price_eur,
      (array_agg(price_eur ORDER BY captured_at DESC))[1] AS current_price_eur,
      array_agg(price_eur ORDER BY captured_at ASC) AS prices_asc
    FROM snap
    GROUP BY ident_key
  ),
  computed AS (
    SELECT
      a.*,
      -- diminuzioni sequenziali >=1%
      (
        SELECT count(*)::integer
        FROM (
          SELECT
            prices_asc[i] AS prev_p,
            prices_asc[i+1] AS next_p
          FROM generate_subscripts(a.prices_asc, 1) g(i)
          WHERE i < array_length(a.prices_asc, 1)
        ) x
        WHERE x.prev_p IS NOT NULL AND x.next_p IS NOT NULL
          AND x.prev_p > 0
          AND ((x.prev_p - x.next_p) / x.prev_p) * 100 >= 1
      ) AS drops_count,
      CASE
        WHEN a.initial_price_eur IS NULL OR a.initial_price_eur <= 0 THEN 0::numeric
        ELSE round(((a.initial_price_eur - a.current_price_eur) / a.initial_price_eur) * 100, 2)
      END AS total_drop_pct
    FROM agg a
  ),
  filtered AS (
    SELECT c.*
    FROM computed c
    WHERE c.observations_count >= 2
      AND c.initial_price_eur IS NOT NULL
      AND c.current_price_eur IS NOT NULL
      AND c.current_price_eur < c.initial_price_eur
      AND c.last_seen_at >= v_max_age_cutoff
      AND (extract(epoch FROM (c.last_seen_at - c.first_seen_at)) / 3600.0) >= 6
      AND c.total_drop_pct >= v_min_drop
  ),
  joined AS (
    SELECT
      f.*,
      pl.id AS pl_id,
      pl.mq AS pl_mq,
      pl.lat AS pl_lat,
      pl.lng AS pl_lng,
      pl.indirizzo AS pl_indirizzo,
      pl.comune AS pl_comune,
      pl.expired_at AS pl_expired_at,
      pl.commercial_zone_slug AS pl_zone_slug,
      pl.omi_zone AS pl_omi_zone,
      pl.zone_match_method AS pl_zmm,
      pl.zone_match_confidence AS pl_zmc,
      pl.titolo AS pl_titolo
    FROM filtered f
    LEFT JOIN LATERAL (
      SELECT p.*
      FROM public.padova_listings p
      WHERE p.url = f.url
      ORDER BY p.last_seen_at DESC NULLS LAST, p.id DESC
      LIMIT 1
    ) pl ON true
  )
  SELECT
    j.ident_key AS source_id,
    j.listing_id,
    j.source,
    j.url,
    -- Title minimizzato: preferisce indirizzo listing, fallback source+listing_id
    coalesce(
      nullif(btrim(j.pl_indirizzo), ''),
      nullif(btrim(j.pl_titolo), ''),
      j.source || ' ' || coalesce(j.listing_id, '')
    ) AS title,
    j.pl_mq AS mq,
    j.pl_lat AS lat,
    j.pl_lng AS lng,
    j.initial_price_eur,
    j.current_price_eur,
    j.total_drop_pct,
    j.drops_count,
    j.observations_count,
    j.first_seen_at,
    j.last_seen_at,
    j.pl_comune AS comune,
    j.pl_omi_zone AS omi_zone,
    j.pl_zone_slug AS commercial_zone_slug,
    j.pl_zmm AS zone_match_method,
    j.pl_zmc AS zone_match_confidence
  FROM joined j
  WHERE j.pl_id IS NOT NULL
    AND j.pl_expired_at IS NULL
    AND lower(coalesce(j.pl_comune, '')) = 'padova'
    AND j.pl_zone_slug IS NOT NULL
    AND NOT public._is_auction_blob(
      coalesce(j.url, '') || ' ' ||
      coalesce(j.pl_titolo, '') || ' ' ||
      coalesce(j.pl_indirizzo, '') || ' ' ||
      coalesce(j.source, '')
    )
  ORDER BY j.total_drop_pct DESC, j.last_seen_at DESC
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops(integer, numeric, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops(integer, numeric, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops(integer, numeric, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_padova_verified_price_drops(integer, numeric, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_padova_verified_price_drops(integer, numeric, integer) TO postgres;

COMMIT;
