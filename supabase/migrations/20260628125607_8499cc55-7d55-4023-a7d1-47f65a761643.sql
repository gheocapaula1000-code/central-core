ALTER TABLE public.padova_contendibili
  ADD COLUMN IF NOT EXISTS ribasso_pct numeric,
  ADD COLUMN IF NOT EXISTS n_ribassi integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_ripubblicato boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS cambio_agenzia boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS giorni_fermo integer,
  ADD COLUMN IF NOT EXISTS n_portali integer DEFAULT 1,
  ADD COLUMN IF NOT EXISTS score_pressione integer DEFAULT 0;

CREATE OR REPLACE FUNCTION public.recompute_padova_contendibili_extras()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_total int;
  v_zona_ok int;
  v_market_ok int;
  v_median_days numeric;
  v_pressure_ok int;
BEGIN
  -- 1) Media €/m² per microzona canonica (solo se >=10 annunci attivi)
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

  -- 2) Data primo annuncio
  CREATE TEMP TABLE _first_seen ON COMMIT DROP AS
  SELECT c.id AS cid, MIN(l.imported_at)::date AS data_primo
  FROM public.padova_contendibili c
  JOIN public.padova_listings l
    ON public.canon_url(l.url) = ANY (
         SELECT public.canon_url(u) FROM unnest(c.urls) u
       )
  WHERE l.imported_at IS NOT NULL
  GROUP BY c.id;

  -- 3) Aggiorna prezzi zona / giorni mercato
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

  -- 4) Segnali pressione da listing_price_snapshots
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

  -- 5) Collega segnali ai contendibili via URL canonico
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
    'con_score_pressione', v_pressure_ok
  );
END;
$$;