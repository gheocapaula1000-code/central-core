-- PR 43 (LIVE Core) — bakeca.it in coda portali + Firecrawl primario
-- per Immobiliare/Idealista (percorso scraping_queue) + sentiment per le
-- 8 zone commerciali ufficiali da dati reali padova_listings.

CREATE OR REPLACE FUNCTION public.process_padova_portal_collect_v2(p_queue_id uuid, p_worker_id uuid, p_listings jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '12s'
 SET lock_timeout TO '3s'
AS $function$
DECLARE
  v_provider   text;
  v_operation  text;
  v_status     text;
  v_processor  text;
  v_pstatus    text;
  v_locked_by  uuid;
  v_locked_to  timestamptz;
  v_ctx        jsonb;
  v_muni       text;
  v_prov       text;
  v_portal     text;
  v_portal_norm text;
  v_portal_host text;
  v_mode       text;
  v_job_ref    text := 'radar_queue:' || p_queue_id::text;

  v_len        int;
  v_item       jsonb;
  v_src        text;
  v_url        text;
  v_host       text;
  v_listing_id_in text;
  v_listing_id text;
  v_url_num    text;
  v_title      text;
  v_address    text;
  v_price_n    numeric;
  v_surface_n  numeric;
  v_rooms_n    numeric;
  v_lat_n      numeric;
  v_lng_n      numeric;
  v_price      numeric;
  v_surface    numeric;
  v_rooms      numeric;
  v_agency     text;
  v_ptype_in   text;
  v_ptype      text;
  v_lat        double precision;
  v_lng        double precision;
  v_is_priv    boolean;   -- NULL | true | false (esplicito)
  v_cap        text;
  v_txt        text;
  v_txt_norm   text;
  v_via_norm   text;
  v_sqm_bkt    int;
  v_cluster_k  text;

  v_existing_id            bigint;
  v_existing_price         numeric;
  v_existing_initial       numeric;
  v_existing_address       text;
  v_existing_lat           double precision;
  v_existing_lng           double precision;
  v_existing_mq            numeric;
  v_existing_locali        numeric;
  v_existing_agency        text;
  v_existing_tipologia     text;
  v_existing_cap           text;
  v_existing_cluster_key   text;
  v_existing_tipo_lead     text;
  v_existing_n_agenzie     int;

  v_new_tipologia          text;
  v_new_cluster_key        text;
  v_new_tipo_lead          text;
  v_new_n_agenzie          int;
  v_new_agency             text;

  v_created  int := 0;
  v_updated  int := 0;
  v_rejected int := 0;
  v_promote  jsonb;

  c_allowed_types constant text[] := ARRAY[
    'appartamento','villa','villetta','attico','loft',
    'rustico','terreno','commerciale','altro'
  ];
BEGIN
  -- ── Guardia service_role/postgres ────────────────────────────────
  IF coalesce(auth.role(),'') <> 'service_role'
     AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  -- ── Lock riga di coda e validazione stato ────────────────────────
  SELECT provider::text, operation, status, processor,
         processor_context, processing_status,
         processing_locked_by, processing_locked_until
    INTO v_provider, v_operation, v_status, v_processor,
         v_ctx, v_pstatus, v_locked_by, v_locked_to
  FROM public.scraping_queue
  WHERE id = p_queue_id
  FOR UPDATE;

  IF v_provider IS NULL THEN
    RAISE EXCEPTION 'queue_id_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_provider IS DISTINCT FROM 'firecrawl' THEN
    RAISE EXCEPTION 'invalid_provider:%', coalesce(v_provider,'null') USING ERRCODE = '22023';
  END IF;
  IF v_operation IS DISTINCT FROM 'scrape' THEN
    RAISE EXCEPTION 'invalid_operation:%', coalesce(v_operation,'null') USING ERRCODE = '22023';
  END IF;
  IF v_status IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION 'invalid_status:%', coalesce(v_status,'null') USING ERRCODE = '22023';
  END IF;
  IF v_processor IS DISTINCT FROM 'padova_portal_collect_v2' THEN
    RAISE EXCEPTION 'invalid_processor:%', coalesce(v_processor,'null') USING ERRCODE = '22023';
  END IF;
  IF v_pstatus IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'invalid_processing_status:%', coalesce(v_pstatus,'null') USING ERRCODE = '22023';
  END IF;
  IF v_locked_by IS DISTINCT FROM p_worker_id THEN
    RAISE EXCEPTION 'lease_not_held_by_worker' USING ERRCODE = '22023';
  END IF;
  IF v_locked_to IS NULL OR v_locked_to <= now() THEN
    RAISE EXCEPTION 'lease_expired' USING ERRCODE = '22023';
  END IF;

  -- ── Context derivato SOLO dalla coda ─────────────────────────────
  v_muni   := v_ctx->>'municipality';
  v_prov   := v_ctx->>'province';
  v_portal := v_ctx->>'portal';
  v_mode   := v_ctx->>'mode';

  IF v_muni IS NULL OR v_muni <> 'Padova' THEN
    RAISE EXCEPTION 'invalid_municipality' USING ERRCODE = '22023';
  END IF;
  IF v_prov IS NULL OR v_prov <> 'PD' THEN
    RAISE EXCEPTION 'invalid_province' USING ERRCODE = '22023';
  END IF;
  IF v_portal IS NULL
     OR v_portal NOT IN ('immobiliare.it','idealista.it','casa.it','subito.it','bakeca.it') THEN
    RAISE EXCEPTION 'invalid_portal:%', coalesce(v_portal,'null') USING ERRCODE = '22023';
  END IF;
  IF v_mode IS NULL OR v_mode NOT IN ('soft','full') THEN
    RAISE EXCEPTION 'invalid_mode:%', coalesce(v_mode,'null') USING ERRCODE = '22023';
  END IF;

  v_portal_norm := split_part(v_portal, '.', 1);
  v_portal_host := 'www.' || v_portal;

  -- ── Validazione payload globale (gestione esplicita di NULL) ─────
  IF p_listings IS NULL THEN
    RAISE EXCEPTION 'listings_null' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_listings) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'listings_not_array' USING ERRCODE = '22023';
  END IF;
  v_len := jsonb_array_length(p_listings);
  IF v_len IS NULL OR v_len < 1 THEN
    RAISE EXCEPTION 'listings_empty' USING ERRCODE = '22023';
  END IF;
  IF v_len > 100 THEN
    RAISE EXCEPTION 'listings_over_cap:%', v_len USING ERRCODE = '22023';
  END IF;

  -- ── Loop annunci in ordine deterministico per URL crescente ─────
  -- Ordine deterministico prima di acquisire pg_advisory_xact_lock:
  -- evita deadlock incrociati fra job concorrenti che condividono URL.
  FOR v_item IN
    SELECT elem
      FROM jsonb_array_elements(p_listings) AS elem
     ORDER BY coalesce(elem->>'url','')
  LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;

    v_src           := v_item->>'source';
    v_url           := v_item->>'url';
    v_listing_id_in := v_item->>'listing_id';
    v_title         := coalesce(v_item->>'title','Annuncio');
    v_address       := NULLIF(v_item->>'address','');
    v_agency        := NULLIF(v_item->>'agency_name','');
    v_ptype_in      := lower(coalesce(v_item->>'property_type','altro'));
    v_ptype         := v_ptype_in;

    IF v_src IS DISTINCT FROM v_portal THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF v_url IS NULL OR v_url !~* '^https://' THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    v_host := lower(substring(v_url from '^https?://([^/]+)'));
    IF v_host IS DISTINCT FROM v_portal_host THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;

    -- listing_id: preferisci il numerico estratto dall'URL, fallback al ricevuto
    v_url_num := substring(v_url from '(\d{5,})(?:[^0-9]|$)');
    v_listing_id := coalesce(v_url_num, nullif(btrim(v_listing_id_in), ''));
    IF v_listing_id IS NULL OR btrim(v_listing_id) = '' THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;

    IF NOT (v_ptype = ANY(c_allowed_types)) THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;

    -- Validazione tipi JSON (solo number o null) e range su numeric,
    -- SENZA cast a double precision prima del controllo.
    IF jsonb_typeof(v_item->'price_eur')   NOT IN ('number','null') THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF jsonb_typeof(v_item->'surface_sqm') NOT IN ('number','null') THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF jsonb_typeof(v_item->'rooms')       NOT IN ('number','null') THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF jsonb_typeof(v_item->'lat')         NOT IN ('number','null') THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF jsonb_typeof(v_item->'lng')         NOT IN ('number','null') THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF jsonb_typeof(v_item->'is_private')  NOT IN ('boolean','null') THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;

    -- Numerici come numeric, poi cast dopo range check
    v_price_n   := NULLIF(v_item->>'price_eur','')::numeric;
    v_surface_n := NULLIF(v_item->>'surface_sqm','')::numeric;
    v_rooms_n   := NULLIF(v_item->>'rooms','')::numeric;
    v_lat_n     := NULLIF(v_item->>'lat','')::numeric;
    v_lng_n     := NULLIF(v_item->>'lng','')::numeric;

    IF v_price_n   IS NOT NULL AND (v_price_n   < 1000 OR v_price_n   > 100000000) THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF v_surface_n IS NOT NULL AND (v_surface_n < 1    OR v_surface_n > 10000)     THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF v_rooms_n   IS NOT NULL AND (v_rooms_n   < 1    OR v_rooms_n   > 100)       THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF v_lat_n     IS NOT NULL AND (v_lat_n     < -90  OR v_lat_n     > 90)        THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF v_lng_n     IS NOT NULL AND (v_lng_n     < -180 OR v_lng_n     > 180)       THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;

    v_price   := v_price_n;
    v_surface := v_surface_n;
    v_rooms   := v_rooms_n;
    v_lat     := v_lat_n::double precision;
    v_lng     := v_lng_n::double precision;

    -- is_private: NULL preservato, non degrada tipo_lead esistente
    IF (v_item ? 'is_private') AND jsonb_typeof(v_item->'is_private') = 'boolean' THEN
      v_is_priv := (v_item->>'is_private')::boolean;
    ELSE
      v_is_priv := NULL;
    END IF;

    -- Guardia geografica: coordinate reali oppure filtro testuale sul testo
    -- normalizzato senza accenti (allineato al parser).
    IF v_lat IS NOT NULL AND v_lng IS NOT NULL
       AND NOT (abs(v_lat) < 0.000001 AND abs(v_lng) < 0.000001) THEN
      IF v_lat < 45.34 OR v_lat > 45.48 OR v_lng < 11.78 OR v_lng > 11.98 THEN
        v_rejected := v_rejected + 1; CONTINUE;
      END IF;
    ELSE
      v_txt := coalesce(v_title,'') || ' ' || coalesce(v_address,'');
      v_txt_norm := translate(
        lower(v_txt),
        'àáâãäåèéêëìíîïòóôõöùúûüýÿñç',
        'aaaaaaeeeeiiiiooooouuuuyync'
      );
      IF v_txt_norm ~ '\m(abano|albignasego|rubano|selvazzano|vigonza|cadoneghe|noventa padovana|ponte san nicolo|vicenza|verona|treviso|venezia|mestre|rovigo|belluno|milano|roma|bologna|torino|firenze)\M' THEN
        v_rejected := v_rejected + 1; CONTINUE;
      END IF;
    END IF;

    -- CAP 351xx da title+address
    v_cap := substring(coalesce(v_title,'') || ' ' || coalesce(v_address,'')
                       from '\m(351\d{2})\M');

    -- cluster_key applicativo (via|sqm_bucket|rooms|type)
    v_via_norm := regexp_replace(
                    regexp_replace(
                      regexp_replace(
                        translate(
                          lower(coalesce(v_address,'')),
                          'àáâãäåèéêëìíîïòóôõöùúûüýÿñç',
                          'aaaaaaeeeeiiiiooooouuuuyync'
                        ),
                        '^(via|viale|v\.le|piazza|p\.zza|piazzale|p\.le|corso|c\.so|largo|vicolo|strada|str\.|borgo|lungargine|riviera|salita)\s+',
                        '', 'i'),
                      '[^a-z0-9]+', '-', 'g'),
                    '^-+|-+$', '', 'g');
    IF v_via_norm <> '' AND v_surface IS NOT NULL AND v_rooms IS NOT NULL THEN
      v_sqm_bkt   := (round(v_surface / 5.0) * 5)::int;
      v_cluster_k := v_via_norm || '|' || v_sqm_bkt::text || '|' ||
                     round(v_rooms)::text || '|' || v_ptype;
    ELSE
      v_cluster_k := NULL;
    END IF;

    -- Advisory lock per URL: unica lock, ordine deterministico garantito
    PERFORM pg_advisory_xact_lock(hashtextextended(v_url, 0));

    SELECT id, prezzo, prezzo_iniziale, raw_address, lat, lng, mq, locali,
           agency, tipologia, cap, cluster_key, tipo_lead, n_agenzie
      INTO v_existing_id, v_existing_price, v_existing_initial,
           v_existing_address, v_existing_lat, v_existing_lng,
           v_existing_mq, v_existing_locali, v_existing_agency,
           v_existing_tipologia, v_existing_cap, v_existing_cluster_key,
           v_existing_tipo_lead, v_existing_n_agenzie
    FROM public.padova_collect_v2_items
    WHERE url = v_url
    ORDER BY id DESC
    LIMIT 1;

    IF v_existing_id IS NULL THEN
      -- INSERT: prezzo_iniziale = prezzo corrente
      v_new_tipo_lead := CASE
        WHEN v_is_priv IS TRUE THEN 'PRIVATO'
        WHEN v_is_priv IS FALSE OR v_agency IS NOT NULL THEN 'AGENZIA'
        ELSE 'AGENZIA'
      END;
      v_new_n_agenzie := CASE
        WHEN v_is_priv IS TRUE THEN 0
        WHEN v_agency IS NOT NULL THEN 1
        ELSE 0
      END;
      v_new_agency := CASE WHEN v_is_priv IS TRUE THEN NULL ELSE v_agency END;

      INSERT INTO public.padova_collect_v2_items (
        job_id, portal, listing_id, url, raw_address, citta, cap,
        lat, lng, tipo_lead, n_agenzie,
        prezzo, prezzo_iniziale, mq, locali, bagni, agency, tipologia,
        cluster_key, raw_json, parse_status, processed_at, http_status,
        log_reason, attempts, created_at
      ) VALUES (
        v_job_ref, v_portal_norm, v_listing_id, v_url,
        coalesce(v_address, v_title), 'Padova', v_cap,
        v_lat, v_lng,
        v_new_tipo_lead, v_new_n_agenzie,
        v_price, v_price, v_surface, v_rooms, NULL, v_new_agency, v_ptype,
        v_cluster_k, v_item, 'radar_queue_ingested', now(), 200,
        v_job_ref, 0, now()
      );
      v_created := v_created + 1;
    ELSE
      -- UPDATE: preserva valori validi esistenti, non degradare campi forti
      v_new_tipologia := CASE
        WHEN v_ptype = 'altro' AND v_existing_tipologia IS NOT NULL
             AND v_existing_tipologia <> 'altro' THEN v_existing_tipologia
        ELSE v_ptype
      END;

      v_new_cluster_key := CASE
        WHEN v_ptype = 'altro'
             AND nullif(btrim(v_existing_tipologia), '') IS NOT NULL
             AND lower(btrim(v_existing_tipologia)) <> 'altro'
             AND v_existing_cluster_key IS NOT NULL
          THEN v_existing_cluster_key
        ELSE coalesce(v_cluster_k, v_existing_cluster_key)
      END;

      IF v_is_priv IS TRUE THEN
        v_new_tipo_lead := 'PRIVATO';
        v_new_n_agenzie := 0;
        v_new_agency    := NULL;
      ELSIF v_agency IS NOT NULL THEN
        v_new_tipo_lead := 'AGENZIA';
        v_new_n_agenzie := 1;
        v_new_agency    := v_agency;
      ELSIF v_is_priv IS FALSE THEN
        v_new_tipo_lead := coalesce(v_existing_tipo_lead, 'AGENZIA');
        v_new_n_agenzie := coalesce(v_existing_n_agenzie,
                                    CASE WHEN v_existing_agency IS NOT NULL THEN 1 ELSE 0 END);
        v_new_agency    := v_existing_agency;
      ELSE
        -- is_private NULL: preserva completamente stato esistente
        v_new_tipo_lead := v_existing_tipo_lead;
        v_new_n_agenzie := v_existing_n_agenzie;
        v_new_agency    := v_existing_agency;
      END IF;

      UPDATE public.padova_collect_v2_items SET
        job_id          = v_job_ref,
        portal          = v_portal_norm,
        listing_id      = coalesce(v_listing_id, listing_id),
        raw_address     = coalesce(v_address, v_existing_address, v_title),
        citta           = 'Padova',
        cap             = coalesce(v_cap, v_existing_cap),
        lat             = coalesce(v_lat, v_existing_lat),
        lng             = coalesce(v_lng, v_existing_lng),
        tipo_lead       = coalesce(v_new_tipo_lead, tipo_lead),
        n_agenzie       = coalesce(v_new_n_agenzie, n_agenzie),
        prezzo          = coalesce(v_price, v_existing_price),
        prezzo_iniziale = coalesce(v_existing_initial, v_existing_price, v_price),
        mq              = coalesce(v_surface, v_existing_mq),
        locali          = coalesce(v_rooms, v_existing_locali),
        bagni           = bagni,
        agency          = v_new_agency,
        tipologia       = v_new_tipologia,
        cluster_key     = v_new_cluster_key,
        raw_json        = v_item,
        parse_status    = 'radar_queue_ingested',
        processed_at    = now(),
        http_status     = 200,
        log_reason      = v_job_ref,
        updated_at      = now()
      WHERE id = v_existing_id;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  -- ── Promozione atomica (stessa transazione, errori NON assorbiti) ────
  v_promote := public.promote_padova_collect_v2_to_listings(now() - interval '6 hours');

  RETURN jsonb_build_object(
    'queue_id', p_queue_id,
    'portal',   v_portal,
    'mode',     v_mode,
    'received', v_len,
    'created',  v_created,
    'updated',  v_updated,
    'rejected', v_rejected,
    'promote',  v_promote
  );
END;
$function$

-- ════════════════════════════════════════════════════════════
-- 20260820090000 — sentiment per le 8 zone commerciali ufficiali,
-- derivato ESCLUSIVAMENTE dai conteggi reali di padova_listings.
-- Nessuna copia dei valori ARPAV a livello comune sulle zone:
-- i campi ambientali restano NULL.
-- ════════════════════════════════════════════════════════════
WITH base AS (
  SELECT
    z.slug,
    COUNT(l.id) FILTER (WHERE l.expired_at IS NULL) AS n_active,
    COUNT(l.id) FILTER (WHERE l.expired_at IS NULL AND l.prezzo IS NOT NULL AND l.mq > 0) AS n_priced,
    ROUND(AVG(l.prezzo / NULLIF(l.mq, 0)) FILTER (WHERE l.expired_at IS NULL AND l.prezzo IS NOT NULL AND l.mq > 0)) AS eur_mq
  FROM public.civiko_commercial_zones z
  LEFT JOIN public.padova_listings l ON l.commercial_zone_slug = z.slug
  GROUP BY z.slug
), agg AS (
  SELECT *, GREATEST(MAX(n_active) OVER (), 1) AS n_max FROM base
)
INSERT INTO public.microzone_sentiment (
  comune, provincia, area_label, area_type,
  investor_fit_score, sentiment_score_total,
  confidence_score, quality, source_refs, data_basis,
  fingerprint, is_active, computed_at, updated_at
)
SELECT
  'Padova', 'PD', slug, 'commercial_zone',
  ROUND(100.0 * n_active / n_max, 1),
  ROUND(100.0 * n_active / n_max, 1),
  CASE WHEN n_active = 0 THEN 0
       ELSE LEAST(0.9, ROUND(n_priced::numeric / NULLIF(n_active, 0), 2)) END,
  CASE WHEN n_active >= 30 THEN 'parziale' ELSE 'insufficiente' END,
  jsonb_build_array(jsonb_build_object(
    'source', 'padova_listings',
    'metric', 'annunci_attivi',
    'n_active', n_active,
    'n_priced', n_priced,
    'eur_mq_medio', eur_mq
  )),
  ARRAY['padova_listings']::text[],
  'commercial_zone:padova:' || slug,
  true, now(), now()
FROM agg
ON CONFLICT (fingerprint) DO UPDATE SET
  investor_fit_score    = EXCLUDED.investor_fit_score,
  sentiment_score_total = EXCLUDED.sentiment_score_total,
  confidence_score      = EXCLUDED.confidence_score,
  quality               = EXCLUDED.quality,
  source_refs           = EXCLUDED.source_refs,
  data_basis            = EXCLUDED.data_basis,
  is_active             = true,
  computed_at           = now(),
  updated_at            = now();
