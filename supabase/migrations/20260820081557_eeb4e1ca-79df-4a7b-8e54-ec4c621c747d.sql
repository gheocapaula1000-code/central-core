-- PR 43 (LIVE Core) — bakeca.it in coda portali + sentiment zone reali
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
  v_is_priv    boolean;
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
  SELECT provider::text, operation, status::text, processor, processing_status,
         locked_by, locked_until, processor_context
    INTO v_provider, v_operation, v_status, v_processor, v_pstatus,
         v_locked_by, v_locked_to, v_ctx
    FROM public.scraping_queue
   WHERE id = p_queue_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'queue_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_provider IS DISTINCT FROM 'firecrawl' OR v_operation IS DISTINCT FROM 'scrape' THEN
    RAISE EXCEPTION 'invalid_provider_operation' USING ERRCODE = '22023';
  END IF;

  IF v_status IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION 'invalid_status:%', coalesce(v_status,'null') USING ERRCODE = '22023';
  END IF;

  IF v_processor IS DISTINCT FROM 'padova_portal_collect_v2' THEN
    RAISE EXCEPTION 'invalid_processor' USING ERRCODE = '22023';
  END IF;

  IF v_pstatus IS DISTINCT FROM 'processing' THEN
    RAISE EXCEPTION 'invalid_processing_status:%', coalesce(v_pstatus,'null') USING ERRCODE = '22023';
  END IF;

  IF v_locked_by IS DISTINCT FROM p_worker_id
     OR v_locked_to IS NULL
     OR v_locked_to <= now() THEN
    RAISE EXCEPTION 'lock_not_held' USING ERRCODE = '22023';
  END IF;

  v_muni   := v_ctx->>'municipality';
  v_prov   := v_ctx->>'province';
  v_portal := v_ctx->>'portal';
  v_mode   := v_ctx->>'mode';

  IF v_muni IS DISTINCT FROM 'Padova' OR v_prov IS DISTINCT FROM 'PD' THEN
    RAISE EXCEPTION 'invalid_scope' USING ERRCODE = '22023';
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

  IF p_listings IS NULL OR jsonb_typeof(p_listings) <> 'array' THEN
    RAISE EXCEPTION 'invalid_listings' USING ERRCODE = '22023';
  END IF;

  v_len := jsonb_array_length(p_listings);
  IF v_len > 100 THEN
    RAISE EXCEPTION 'too_many_listings:%', v_len USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT jsonb_array_elements(p_listings) LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      v_rejected := v_rejected + 1;
      CONTINUE;
    END IF;

    v_src  := v_item->>'source';
    v_url  := v_item->>'url';
    v_listing_id_in := v_item->>'listing_id';

    IF v_src IS DISTINCT FROM v_portal THEN
      v_rejected := v_rejected + 1;
      CONTINUE;
    END IF;

    IF v_url IS NULL OR v_url !~ '^https://' THEN
      v_rejected := v_rejected + 1;
      CONTINUE;
    END IF;

    v_host := lower(substring(v_url from '^https?://([^/]+)'));
    IF v_host IS DISTINCT FROM v_portal_host THEN
      v_rejected := v_rejected + 1;
      CONTINUE;
    END IF;

    IF v_listing_id_in IS NULL OR length(v_listing_id_in) < 3 THEN
      v_rejected := v_rejected + 1;
      CONTINUE;
    END IF;

    v_listing_id := v_listing_id_in;
    v_url_num := substring(v_listing_id from '(\d{5,})');

    v_title := nullif(btrim(coalesce(v_item->>'title','')), '');
    v_address := nullif(btrim(coalesce(v_item->>'address','')), '');

    BEGIN v_price_n := (v_item->>'price_eur')::numeric; EXCEPTION WHEN others THEN v_price_n := NULL; END;
    BEGIN v_surface_n := (v_item->>'surface_sqm')::numeric; EXCEPTION WHEN others THEN v_surface_n := NULL; END;
    BEGIN v_rooms_n := (v_item->>'rooms')::numeric; EXCEPTION WHEN others THEN v_rooms_n := NULL; END;
    BEGIN v_lat_n := (v_item->>'lat')::numeric; EXCEPTION WHEN others THEN v_lat_n := NULL; END;
    BEGIN v_lng_n := (v_item->>'lng')::numeric; EXCEPTION WHEN others THEN v_lng_n := NULL; END;

    v_price   := CASE WHEN v_price_n BETWEEN 1000 AND 5000000 THEN round(v_price_n) ELSE NULL END;
    v_surface := CASE WHEN v_surface_n BETWEEN 8 AND 2000 THEN round(v_surface_n) ELSE NULL END;
    v_rooms   := CASE WHEN v_rooms_n BETWEEN 1 AND 30 THEN round(v_rooms_n) ELSE NULL END;
    v_lat     := CASE WHEN v_lat_n BETWEEN 45.34 AND 45.48 THEN v_lat_n::double precision ELSE NULL END;
    v_lng     := CASE WHEN v_lng_n BETWEEN 11.78 AND 11.98 THEN v_lng_n::double precision ELSE NULL END;

    v_agency := nullif(btrim(coalesce(v_item->>'agency_name','')), '');
    IF v_agency IS NOT NULL THEN v_agency := left(v_agency, 150); END IF;

    v_ptype_in := lower(coalesce(v_item->>'property_type',''));
    v_ptype := CASE WHEN v_ptype_in = ANY (c_allowed_types) THEN v_ptype_in ELSE 'altro' END;

    IF (v_item ? 'is_private') AND jsonb_typeof(v_item->'is_private') = 'boolean' THEN
      v_is_priv := (v_item->>'is_private')::boolean;
    ELSE
      v_is_priv := NULL;
    END IF;

    v_txt := coalesce(v_title,'') || ' ' || coalesce(v_address,'');
    v_cap := substring(v_txt from '\m(35\d{3})\M');
    v_txt_norm := public.padova_descr_norm(v_txt);
    v_via_norm := public.norm_via(coalesce(v_address, v_title, ''));
    v_sqm_bkt := CASE WHEN v_surface IS NULL THEN NULL ELSE (v_surface::int / 10) * 10 END;
    v_cluster_k := public.compute_cluster_key(v_via_norm, v_sqm_bkt, v_cap);

    INSERT INTO public.padova_collect_v2_items (
      job_id, portal, listing_id, url, raw_address, citta, cap,
      prezzo, mq, locali, agenzia, tipologia, lat, lng,
      is_privato, cluster_key, titolo, descr_norm, via_norm, raw_json, created_at
    ) VALUES (
      v_job_ref, v_portal_norm, v_listing_id, v_url,
      v_address, 'Padova', v_cap,
      v_price, v_surface, v_rooms, v_agency, v_ptype, v_lat, v_lng,
      v_is_priv, v_cluster_k, v_title, v_txt_norm, v_via_norm, v_item, now()
    )
    ON CONFLICT DO NOTHING;

    SELECT id, prezzo, indirizzo, lat, lng, mq, locali, agency, ev_tipologia, tipo_lead
      INTO v_existing_id, v_existing_price, v_existing_address, v_existing_lat,
           v_existing_lng, v_existing_mq, v_existing_locali, v_existing_agency,
           v_existing_tipologia, v_existing_tipo_lead
      FROM public.padova_listings
     WHERE url = v_url
     LIMIT 1;

    IF v_existing_id IS NULL THEN
      INSERT INTO public.padova_listings (
        fonte, url, indirizzo, comune, prezzo, mq, locali, agency,
        lat, lng, raw_json, imported_at, last_seen_at
      ) VALUES (
        v_portal_norm, v_url, v_address, 'Padova',
        v_price, v_surface, v_rooms, v_agency, v_lat, v_lng,
        v_item, now(), now()
      )
      ON CONFLICT (url) DO NOTHING;
      v_created := v_created + 1;
    ELSE
      UPDATE public.padova_listings
         SET prezzo = coalesce(v_price, prezzo),
             mq = coalesce(v_surface, mq),
             locali = coalesce(v_rooms, locali),
             agency = coalesce(v_agency, agency),
             indirizzo = coalesce(v_address, indirizzo),
             lat = coalesce(v_lat, lat),
             lng = coalesce(v_lng, lng),
             portal = v_portal_norm,
             raw_json = coalesce(v_item, raw_json),
             last_seen_at = now(),
             expired_at = NULL
       WHERE id = v_existing_id;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'portal',   v_portal,
    'mode',     v_mode,
    'received', v_len,
    'created',  v_created,
    'updated',  v_updated,
    'rejected', v_rejected
  );
END;
$function$;

-- Sentiment per le 8 zone commerciali ufficiali da dati reali padova_listings.
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