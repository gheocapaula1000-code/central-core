-- CHECKPOINT 5D — fix "UPDATE requires a WHERE clause" (pg_safeupdate on authenticator role)
-- Cause: UPDATE ... FROM <join> leaves the ModifyTable subplan without a restriction qual.
-- Fix: pre-materialize target PKs and use single-table UPDATEs filtered by PK array.

CREATE OR REPLACE FUNCTION public.detect_padova_cambio_agenzia()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_urls_scan     int;
  v_urls_cambio   int;
  v_marcati       int := 0;
  v_cambi_scritti int;
  v_ids           bigint[];
BEGIN
  CREATE TEMP TABLE _placeholders(norm text) ON COMMIT DROP;
  INSERT INTO _placeholders(norm) VALUES
    ('disponibile non'),('non specificato'),('non'),('specificato'),
    ('privato'),('private'),('r');

  CREATE TEMP TABLE _snap ON COMMIT DROP AS
  SELECT
    public.canon_url(url)                AS curl,
    source                               AS portale,
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
   WHERE norm_name IS NULL OR norm_name = ''
      OR norm_name IN (SELECT norm FROM _placeholders);

  CREATE TEMP TABLE _changes ON COMMIT DROP AS
  WITH pairs AS (
    SELECT
      a.curl,
      a.captured_at AS t_prev,
      b.captured_at AS t_new,
      a.raw_name    AS name_prev,
      b.raw_name    AS name_new,
      b.portale     AS portale,
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
  SELECT curl, t_prev, t_new, name_prev, name_new, portale
  FROM pairs
  WHERE rn = 1;

  SELECT COUNT(DISTINCT curl) INTO v_urls_scan   FROM _snap;
  SELECT COUNT(*)             INTO v_urls_cambio FROM _changes;

  -- 2a) Reset marcatura sui contendibili (idempotente, comportamento invariato)
  UPDATE public.padova_contendibili
     SET cambio_agenzia = false,
         cambio_agenzia_data = NULL,
         cambio_agenzia_da   = NULL,
         cambio_agenzia_a    = NULL
   WHERE cambio_agenzia = true OR cambio_agenzia_data IS NOT NULL;

  -- 2b) Candidati (rn = 1) materializzati su PK
  CREATE TEMP TABLE _cand ON COMMIT DROP AS
  WITH cand AS (
    SELECT c.id AS cid, ch.t_new, ch.name_prev, ch.name_new,
           ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY ch.t_new DESC) AS rn
    FROM public.padova_contendibili c
    JOIN _changes ch
      ON ch.curl = ANY (SELECT public.canon_url(u) FROM unnest(c.urls) u)
  )
  SELECT cid, t_new, name_prev, name_new FROM cand WHERE rn = 1;

  v_ids := ARRAY(SELECT cid FROM _cand);

  IF COALESCE(array_length(v_ids, 1), 0) > 0 THEN
    UPDATE public.padova_contendibili c
       SET cambio_agenzia      = true,
           cambio_agenzia_data = (SELECT k.t_new      FROM _cand k WHERE k.cid = c.id),
           cambio_agenzia_da   = (SELECT k.name_prev  FROM _cand k WHERE k.cid = c.id),
           cambio_agenzia_a    = (SELECT k.name_new   FROM _cand k WHERE k.cid = c.id)
     WHERE c.id = ANY (v_ids);
    GET DIAGNOSTICS v_marcati = ROW_COUNT;
  END IF;

  -- 2c) URL con overlap contendibili (per flag informativo)
  CREATE TEMP TABLE _overlap ON COMMIT DROP AS
  SELECT DISTINCT public.canon_url(u) AS curl
  FROM public.padova_contendibili c, unnest(c.urls) u;

  -- 2d) Snapshot immobile dal collect v2 (l'item più recente per canon_url)
  CREATE TEMP TABLE _snapshot ON COMMIT DROP AS
  SELECT DISTINCT ON (public.canon_url(url))
    public.canon_url(url) AS curl,
    tipologia, raw_address, quartiere, omi_zone, prezzo, mq, locali
  FROM public.padova_collect_v2_items
  WHERE url IS NOT NULL
  ORDER BY public.canon_url(url), updated_at DESC NULLS LAST, created_at DESC;

  -- 2e) Upsert lead: uno per (canon_url, data_cambio più recente)
  WITH ins AS (
    INSERT INTO public.padova_cambi_agenzia AS pca (
      canon_url, portale, agenzia_precedente, agenzia_nuova, data_cambio,
      titolo, indirizzo, quartiere, zona_omi, prezzo_eur, mq, locali,
      contendibile_overlap
    )
    SELECT
      ch.curl, ch.portale, ch.name_prev, ch.name_new, ch.t_new,
      s.tipologia, s.raw_address, s.quartiere, s.omi_zone,
      s.prezzo, s.mq, s.locali,
      (o.curl IS NOT NULL)
    FROM _changes ch
    LEFT JOIN _snapshot s ON s.curl = ch.curl
    LEFT JOIN _overlap  o ON o.curl = ch.curl
    ON CONFLICT (canon_url, data_cambio) DO UPDATE
      SET last_seen_at         = now(),
          portale              = COALESCE(EXCLUDED.portale, pca.portale),
          agenzia_precedente   = EXCLUDED.agenzia_precedente,
          agenzia_nuova        = EXCLUDED.agenzia_nuova,
          titolo               = COALESCE(EXCLUDED.titolo, pca.titolo),
          indirizzo            = COALESCE(EXCLUDED.indirizzo, pca.indirizzo),
          quartiere            = COALESCE(EXCLUDED.quartiere, pca.quartiere),
          zona_omi             = COALESCE(EXCLUDED.zona_omi, pca.zona_omi),
          prezzo_eur           = COALESCE(EXCLUDED.prezzo_eur, pca.prezzo_eur),
          mq                   = COALESCE(EXCLUDED.mq, pca.mq),
          locali               = COALESCE(EXCLUDED.locali, pca.locali),
          contendibile_overlap = EXCLUDED.contendibile_overlap,
          is_active            = true
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_cambi_scritti FROM ins;

  RETURN jsonb_build_object(
    'ok', true,
    'urls_scannati', v_urls_scan,
    'urls_con_cambio', v_urls_cambio,
    'cambi_scritti', v_cambi_scritti,
    'contendibili_marcati', v_marcati
  );
END;
$function$;

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
  v_ids bigint[];
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

  -- Valori derivati precalcolati per PK (stesse formule)
  CREATE TEMP TABLE _extras ON COMMIT DROP AS
  SELECT
    c.id AS cid,
    CASE
      WHEN c.mq IS NOT NULL AND c.mq > 0 AND c.prezzo_min IS NOT NULL AND c.prezzo_max IS NOT NULL
      THEN ROUND( ((c.prezzo_min + c.prezzo_max)::numeric / 2.0) / c.mq, 0)
      ELSE NULL
    END AS prezzo_immobile_eur_mq,
    z.avg_eur_mq AS prezzo_medio_zona_eur_mq,
    CASE
      WHEN z.avg_eur_mq IS NOT NULL AND z.avg_eur_mq > 0
           AND c.mq IS NOT NULL AND c.mq > 0
           AND c.prezzo_min IS NOT NULL AND c.prezzo_max IS NOT NULL
      THEN ROUND(
        ( ( ((c.prezzo_min + c.prezzo_max)::numeric / 2.0) / c.mq - z.avg_eur_mq )
          / z.avg_eur_mq ) * 100, 1)
      ELSE NULL
    END AS differenza_zona_pct,
    f.data_primo AS data_primo_annuncio,
    CASE
      WHEN f.data_primo IS NOT NULL
      THEN GREATEST(0, (CURRENT_DATE - f.data_primo)::int)
      ELSE NULL
    END AS giorni_sul_mercato
  FROM public.padova_contendibili c
  LEFT JOIN _zone_avg z ON z.q = public.canon_quartiere(c.quartiere)
  LEFT JOIN _first_seen f ON f.cid = c.id;

  CREATE UNIQUE INDEX ON _extras (cid);

  v_ids := ARRAY(SELECT cid FROM _extras);

  IF COALESCE(array_length(v_ids, 1), 0) > 0 THEN
    UPDATE public.padova_contendibili c
       SET prezzo_immobile_eur_mq   = (SELECT e.prezzo_immobile_eur_mq   FROM _extras e WHERE e.cid = c.id),
           prezzo_medio_zona_eur_mq = (SELECT e.prezzo_medio_zona_eur_mq FROM _extras e WHERE e.cid = c.id),
           differenza_zona_pct      = (SELECT e.differenza_zona_pct      FROM _extras e WHERE e.cid = c.id),
           data_primo_annuncio      = (SELECT e.data_primo_annuncio      FROM _extras e WHERE e.cid = c.id),
           giorni_sul_mercato       = (SELECT e.giorni_sul_mercato       FROM _extras e WHERE e.cid = c.id)
     WHERE c.id = ANY (v_ids);
  END IF;

  CREATE TEMP TABLE _signals ON COMMIT DROP AS
  WITH eventi AS (
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
    UNION ALL
    SELECT
      l.url,
      public.canon_url(l.url) AS curl,
      h.prezzo AS price_eur,
      h.snapshot_date::timestamptz AS captured_at,
      l.fonte AS source
    FROM public.padova_listings_price_history h
    JOIN public.padova_listings l ON l.id = h.listing_id
    WHERE l.url IS NOT NULL
      AND h.prezzo IS NOT NULL
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
  FROM eventi
  GROUP BY curl;

  -- Pressione precalcolata per PK (stesse formule e soglie)
  CREATE TEMP TABLE _press ON COMMIT DROP AS
  SELECT
    agg.cid,
    agg.ribasso_pct,
    agg.n_ribassi,
    agg.is_ripubblicato,
    agg.giorni_fermo,
    agg.n_portali,
    (
      COALESCE(agg.n_agenzie, 1) * 30
      + CASE WHEN agg.ribasso_pct > 10 THEN 25
             WHEN agg.ribasso_pct > 5 THEN 10
             ELSE 0 END
      + CASE WHEN agg.is_ripubblicato THEN 20 ELSE 0 END
      + CASE WHEN agg.giorni_fermo > 120 THEN 20
             WHEN agg.giorni_fermo > 60 THEN 10
             ELSE 0 END
      + COALESCE(agg.n_ribassi, 0) * 5
    )::int AS score_pressione
  FROM (
    SELECT
      c2.id AS cid,
      c2.n_agenzie AS n_agenzie,
      MAX(s.ribasso_pct)         AS ribasso_pct,
      MAX(s.n_ribassi)           AS n_ribassi,
      bool_or(s.is_ripubblicato) AS is_ripubblicato,
      MAX(s.giorni_fermo)        AS giorni_fermo,
      MAX(s.n_portali)           AS n_portali
    FROM public.padova_contendibili c2
    JOIN _signals s
      ON s.curl = ANY (
        SELECT public.canon_url(u) FROM unnest(c2.urls) u
      )
    GROUP BY c2.id, c2.n_agenzie
  ) agg;

  CREATE UNIQUE INDEX ON _press (cid);

  v_ids := ARRAY(SELECT cid FROM _press);

  IF COALESCE(array_length(v_ids, 1), 0) > 0 THEN
    UPDATE public.padova_contendibili c
       SET ribasso_pct     = (SELECT p.ribasso_pct     FROM _press p WHERE p.cid = c.id),
           n_ribassi       = (SELECT p.n_ribassi       FROM _press p WHERE p.cid = c.id),
           is_ripubblicato = (SELECT p.is_ripubblicato FROM _press p WHERE p.cid = c.id),
           giorni_fermo    = (SELECT p.giorni_fermo    FROM _press p WHERE p.cid = c.id),
           n_portali       = (SELECT p.n_portali       FROM _press p WHERE p.cid = c.id),
           score_pressione = (SELECT p.score_pressione FROM _press p WHERE p.cid = c.id)
     WHERE c.id = ANY (v_ids);
  END IF;

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
    'senza_giorni_mercato', v_market_ok - v_market_ok + (v_total - v_market_ok),
    'mediana_giorni_mercato', v_median_days,
    'con_score_pressione', v_pressure_ok,
    'cambio_agenzia', v_cambio
  );
END;
$function$;