-- 1) Colonne dettaglio cambio agenzia
ALTER TABLE public.padova_contendibili
  ADD COLUMN IF NOT EXISTS cambio_agenzia_data timestamptz,
  ADD COLUMN IF NOT EXISTS cambio_agenzia_da   text,
  ADD COLUMN IF NOT EXISTS cambio_agenzia_a    text;

-- 2) Normalizzazione nome agenzia (set-based, immutable)
CREATE OR REPLACE FUNCTION public.norm_agency_name(p text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT NULLIF(
    (
      SELECT string_agg(t, ' ' ORDER BY t)
      FROM unnest(
        regexp_split_to_array(
          regexp_replace(
            regexp_replace(lower(coalesce(p,'')), '[^a-z0-9 ]', ' ', 'g'),
            '\y(srl|srls|sas|snc|spa|di|e|c|impresa|autonoma|agenzia|immobiliare|immobili|immobiliari|real|estate|group|gruppo|mls|studio|the|and)\y',
            ' ', 'g'),
          '\s+')
      ) AS t
      WHERE length(t) >= 2
    ),
  '');
$$;

-- 3) Detector cambio agenzia (idempotente)
CREATE OR REPLACE FUNCTION public.detect_padova_cambio_agenzia()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_urls_scan   int;
  v_urls_cambio int;
  v_marcati     int;
BEGIN
  CREATE TEMP TABLE _placeholders(norm text) ON COMMIT DROP;
  INSERT INTO _placeholders(norm) VALUES
    ('disponibile non'),
    ('non specificato'),
    ('non'),
    ('specificato'),
    ('privato'),
    ('private'),
    ('r');

  CREATE TEMP TABLE _snap ON COMMIT DROP AS
  SELECT
    public.canon_url(url)                AS curl,
    captured_at,
    agency_name                          AS raw_name,
    public.norm_agency_name(agency_name) AS norm_name,
    regexp_split_to_array(public.norm_agency_name(agency_name), '\s+') AS tokens
  FROM public.listing_price_snapshots
  WHERE municipality ILIKE 'padova'
    AND captured_at > now() - interval '90 days'
    AND url IS NOT NULL
    AND agency_name IS NOT NULL
    AND btrim(agency_name) <> '';

  DELETE FROM _snap
   WHERE norm_name IS NULL
      OR norm_name = ''
      OR norm_name IN (SELECT norm FROM _placeholders);

  CREATE TEMP TABLE _changes ON COMMIT DROP AS
  WITH pairs AS (
    SELECT
      a.curl,
      a.captured_at AS t_prev,
      b.captured_at AS t_new,
      a.raw_name    AS name_prev,
      b.raw_name    AS name_new,
      ROW_NUMBER() OVER (
        PARTITION BY a.curl
        ORDER BY b.captured_at DESC, a.captured_at DESC
      ) AS rn
    FROM _snap a
    JOIN _snap b
      ON a.curl = b.curl
     AND b.captured_at > a.captured_at
     AND (b.captured_at - a.captured_at) >= interval '1 day'
     AND a.norm_name <> b.norm_name
     AND NOT (a.tokens <@ b.tokens)
     AND NOT (b.tokens <@ a.tokens)
  )
  SELECT curl, t_prev, t_new, name_prev, name_new
  FROM pairs
  WHERE rn = 1;

  SELECT COUNT(DISTINCT curl) INTO v_urls_scan   FROM _snap;
  SELECT COUNT(*)             INTO v_urls_cambio FROM _changes;

  UPDATE public.padova_contendibili
     SET cambio_agenzia = false,
         cambio_agenzia_data = NULL,
         cambio_agenzia_da   = NULL,
         cambio_agenzia_a    = NULL
   WHERE cambio_agenzia = true
      OR cambio_agenzia_data IS NOT NULL;

  WITH cand AS (
    SELECT c.id AS cid, ch.t_new, ch.name_prev, ch.name_new,
           ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY ch.t_new DESC) AS rn
    FROM public.padova_contendibili c
    JOIN _changes ch
      ON ch.curl = ANY (
        SELECT public.canon_url(u) FROM unnest(c.urls) u
      )
  )
  UPDATE public.padova_contendibili c
     SET cambio_agenzia      = true,
         cambio_agenzia_data = cand.t_new,
         cambio_agenzia_da   = cand.name_prev,
         cambio_agenzia_a    = cand.name_new
    FROM cand
   WHERE c.id = cand.cid
     AND cand.rn = 1;

  GET DIAGNOSTICS v_marcati = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'urls_scannati', v_urls_scan,
    'urls_con_cambio', v_urls_cambio,
    'contendibili_marcati', v_marcati
  );
END;
$$;

-- 4) Sostituzione recompute_padova_contendibili_extras: aggancio detector alla fine
CREATE OR REPLACE FUNCTION public.recompute_padova_contendibili_extras()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_total int;
  v_zona_ok int;
  v_market_ok int;
  v_median_days numeric;
  v_pressure_ok int;
  v_cambio jsonb;
BEGIN
  CREATE TEMP TABLE _zone_avg ON COMMIT DROP AS
  WITH base AS (
    SELECT public.canon_quartiere(quartiere) AS q,
           (prezzo::numeric / NULLIF(mq,0)) AS eur_mq
    FROM public.padova_listings
    WHERE prezzo IS NOT NULL AND prezzo > 0
      AND mq IS NOT NULL AND mq > 0
      AND quartiere IS NOT NULL
  )
  SELECT q, ROUND(AVG(eur_mq), 0)::numeric AS avg_eur_mq, count(*)::int AS n
  FROM base
  WHERE q IS NOT NULL
  GROUP BY q
  HAVING count(*) >= 10;

  CREATE TEMP TABLE _first_seen ON COMMIT DROP AS
  SELECT c.id AS cid, MIN(l.imported_at)::date AS data_primo
  FROM public.padova_contendibili c
  JOIN public.padova_listings l
    ON public.canon_url(l.url) = ANY (
         SELECT public.canon_url(u) FROM unnest(c.urls) u
       )
  WHERE l.imported_at IS NOT NULL
  GROUP BY c.id;

  UPDATE public.padova_contendibili c
     SET prezzo_immobile_eur_mq = CASE
            WHEN c.mq IS NOT NULL AND c.mq > 0 AND c.prezzo_min IS NOT NULL AND c.prezzo_max IS NOT NULL
            THEN ROUND( ((c.prezzo_min + c.prezzo_max)::numeric / 2.0) / c.mq, 0)
            ELSE NULL
          END,
         prezzo_medio_zona_eur_mq = z.avg_eur_mq,
         differenza_zona_pct = CASE
            WHEN z.avg_eur_mq IS NOT NULL AND z.avg_eur_mq > 0
                 AND c.mq IS NOT NULL AND c.mq > 0
                 AND c.prezzo_min IS NOT NULL AND c.prezzo_max IS NOT NULL
            THEN ROUND(
              ( ( ((c.prezzo_min + c.prezzo_max)::numeric / 2.0) / c.mq - z.avg_eur_mq )
                / z.avg_eur_mq ) * 100, 1)
            ELSE NULL
          END,
         data_primo_annuncio = f.data_primo,
         giorni_sul_mercato = CASE
            WHEN f.data_primo IS NOT NULL
            THEN GREATEST(0, (CURRENT_DATE - f.data_primo)::int)
            ELSE NULL
          END
    FROM (SELECT id, quartiere FROM public.padova_contendibili) base
    LEFT JOIN _zone_avg z ON z.q = public.canon_quartiere(base.quartiere)
    LEFT JOIN _first_seen f ON f.cid = base.id
   WHERE c.id = base.id;

  CREATE TEMP TABLE _signals ON COMMIT DROP AS
  WITH snap AS (
    SELECT
      lps.url,
      public.canon_url(lps.url) AS curl,
      lps.price_eur,
      lps.captured_at,
      lps.source
    FROM public.listing_price_snapshots lps
    WHERE lps.municipality ILIKE 'padova'
      AND lps.url IS NOT NULL
      AND lps.price_eur IS NOT NULL
  )
  SELECT
    curl,
    MIN(price_eur) AS price_min_ever,
    MAX(price_eur) AS price_max_ever,
    MIN(captured_at) AS first_seen,
    MAX(captured_at) AS last_seen,
    COUNT(DISTINCT price_eur) AS n_distinct_prices,
    COUNT(DISTINCT source)::int AS n_portali,
    CASE
      WHEN MAX(price_eur) > 0 AND MIN(price_eur) < MAX(price_eur)
      THEN ROUND(((MAX(price_eur) - MIN(price_eur))::numeric
                  / MAX(price_eur)) * 100, 1)
      ELSE 0
    END AS ribasso_pct,
    GREATEST(COUNT(DISTINCT price_eur)::int - 1, 0) AS n_ribassi,
    CASE
      WHEN MAX(captured_at) - MIN(captured_at) > INTERVAL '60 days'
       AND COUNT(DISTINCT price_eur) > 1
      THEN true ELSE false
    END AS is_ripubblicato,
    (CURRENT_DATE - MAX(captured_at)::date)::int AS giorni_fermo,
    array_agg(DISTINCT url) AS urls
  FROM snap
  GROUP BY curl;

  UPDATE public.padova_contendibili c
     SET ribasso_pct      = agg.ribasso_pct,
         n_ribassi        = agg.n_ribassi,
         is_ripubblicato  = agg.is_ripubblicato,
         giorni_fermo     = agg.giorni_fermo,
         n_portali        = agg.n_portali,
         score_pressione  = (
           COALESCE(c.n_agenzie, 1) * 30
           + CASE WHEN agg.ribasso_pct > 10 THEN 25
                  WHEN agg.ribasso_pct > 5 THEN 10
                  ELSE 0 END
           + CASE WHEN agg.is_ripubblicato THEN 20 ELSE 0 END
           + CASE WHEN agg.giorni_fermo > 120 THEN 20
                  WHEN agg.giorni_fermo > 60 THEN 10
                  ELSE 0 END
           + COALESCE(agg.n_ribassi, 0) * 5
         )
    FROM (
      SELECT
        c2.id AS cid,
        MAX(s.ribasso_pct)       AS ribasso_pct,
        MAX(s.n_ribassi)         AS n_ribassi,
        bool_or(s.is_ripubblicato) AS is_ripubblicato,
        MAX(s.giorni_fermo)      AS giorni_fermo,
        MAX(s.n_portali)         AS n_portali
      FROM public.padova_contendibili c2
      JOIN _signals s
        ON s.curl = ANY (
          SELECT public.canon_url(u) FROM unnest(c2.urls) u
        )
      GROUP BY c2.id
    ) agg
   WHERE c.id = agg.cid;

  -- Rilevamento cambio agenzia (append alla pipeline)
  v_cambio := public.detect_padova_cambio_agenzia();

  SELECT count(*) INTO v_total FROM public.padova_contendibili;
  SELECT count(*) INTO v_zona_ok FROM public.padova_contendibili WHERE prezzo_medio_zona_eur_mq IS NOT NULL;
  SELECT count(*) INTO v_market_ok FROM public.padova_contendibili WHERE giorni_sul_mercato IS NOT NULL;
  SELECT count(*) INTO v_pressure_ok FROM public.padova_contendibili WHERE score_pressione > 0;
  SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY giorni_sul_mercato)
    INTO v_median_days
    FROM public.padova_contendibili WHERE giorni_sul_mercato IS NOT NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'totale', v_total,
    'con_prezzo_medio_zona', v_zona_ok,
    'senza_prezzo_medio_zona', v_total - v_zona_ok,
    'con_giorni_mercato', v_market_ok,
    'senza_giorni_mercato', v_total - v_market_ok,
    'mediana_giorni_mercato', v_median_days,
    'con_score_pressione', v_pressure_ok,
    'cambio_agenzia', v_cambio
  );
END;
$function$;