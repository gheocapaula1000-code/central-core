
ALTER TABLE public.padova_contendibili
  ADD COLUMN IF NOT EXISTS prezzo_medio_zona_eur_mq numeric,
  ADD COLUMN IF NOT EXISTS prezzo_immobile_eur_mq numeric,
  ADD COLUMN IF NOT EXISTS differenza_zona_pct numeric,
  ADD COLUMN IF NOT EXISTS giorni_sul_mercato integer,
  ADD COLUMN IF NOT EXISTS data_primo_annuncio date;

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

  -- 2) Data primo annuncio per ogni contendibile (min imported_at fra i listing collegati via URL canonico)
  CREATE TEMP TABLE _first_seen ON COMMIT DROP AS
  SELECT c.id AS cid, MIN(l.imported_at)::date AS data_primo
  FROM public.padova_contendibili c
  JOIN public.padova_listings l
    ON public.canon_url(l.url) = ANY (
         SELECT public.canon_url(u) FROM unnest(c.urls) u
       )
  WHERE l.imported_at IS NOT NULL
  GROUP BY c.id;

  -- 3) Aggiorna i 5 campi
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

  SELECT count(*) INTO v_total FROM public.padova_contendibili;
  SELECT count(*) INTO v_zona_ok FROM public.padova_contendibili WHERE prezzo_medio_zona_eur_mq IS NOT NULL;
  SELECT count(*) INTO v_market_ok FROM public.padova_contendibili WHERE giorni_sul_mercato IS NOT NULL;
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
    'mediana_giorni_mercato', v_median_days
  );
END;
$$;
