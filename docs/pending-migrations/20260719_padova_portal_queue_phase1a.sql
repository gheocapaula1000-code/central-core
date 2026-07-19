-- ============================================================================
-- Fase 1A shadow mode — process_padova_portal_collect_v2 (corretta)
-- Non applicare automaticamente.
--
-- Prerequisiti:
--   - public.scraping_queue con colonne processing_* già presenti
--     (id, provider, operation, status, processor, processor_context,
--      processing_status, processing_locked_by, processing_locked_until)
--   - public.padova_collect_v2_items già esistente
--   - public.promote_padova_collect_v2_to_listings(timestamptz) già esistente
-- Effetti: sostituisce (CREATE OR REPLACE) la sola RPC
--          process_padova_portal_collect_v2 con nuova firma.
--          Nessuna modifica strutturale a tabelle esistenti.
-- ============================================================================

BEGIN;

-- Drop della vecchia firma (uuid, jsonb, jsonb) se presente
DROP FUNCTION IF EXISTS public.process_padova_portal_collect_v2(uuid, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.process_padova_portal_collect_v2(
  p_queue_id  uuid,
  p_worker_id uuid,
  p_listings  jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
  v_listing_id text;
  v_title      text;
  v_address    text;
  v_price      numeric;
  v_surface    numeric;
  v_rooms      numeric;
  v_agency     text;
  v_ptype      text;
  v_lat        double precision;
  v_lng        double precision;
  v_is_priv    boolean;
  v_cap        text;
  v_txt        text;
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
  IF v_provider <> 'firecrawl' THEN
    RAISE EXCEPTION 'invalid_provider:%', v_provider USING ERRCODE = '22023';
  END IF;
  IF v_operation <> 'scrape' THEN
    RAISE EXCEPTION 'invalid_operation:%', v_operation USING ERRCODE = '22023';
  END IF;
  IF v_status <> 'succeeded' THEN
    RAISE EXCEPTION 'invalid_status:%', v_status USING ERRCODE = '22023';
  END IF;
  IF v_processor <> 'padova_portal_collect_v2' THEN
    RAISE EXCEPTION 'invalid_processor:%', v_processor USING ERRCODE = '22023';
  END IF;
  IF v_pstatus <> 'running' THEN
    RAISE EXCEPTION 'invalid_processing_status:%', v_pstatus USING ERRCODE = '22023';
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

  IF v_muni   IS DISTINCT FROM 'Padova' THEN
    RAISE EXCEPTION 'invalid_municipality' USING ERRCODE = '22023';
  END IF;
  IF v_prov   IS DISTINCT FROM 'PD' THEN
    RAISE EXCEPTION 'invalid_province' USING ERRCODE = '22023';
  END IF;
  IF v_portal NOT IN ('immobiliare.it','idealista.it','casa.it','subito.it') THEN
    RAISE EXCEPTION 'invalid_portal:%', v_portal USING ERRCODE = '22023';
  END IF;
  IF v_mode   NOT IN ('soft','full') THEN
    RAISE EXCEPTION 'invalid_mode:%', v_mode USING ERRCODE = '22023';
  END IF;

  v_portal_norm := split_part(v_portal, '.', 1);           -- immobiliare|idealista|casa|subito
  v_portal_host := 'www.' || v_portal;                     -- www.<portal>

  -- ── Validazione payload globale ──────────────────────────────────
  IF jsonb_typeof(p_listings) <> 'array' THEN
    RAISE EXCEPTION 'listings_not_array' USING ERRCODE = '22023';
  END IF;
  v_len := jsonb_array_length(p_listings);
  IF v_len > 100 THEN
    RAISE EXCEPTION 'listings_over_cap:%', v_len USING ERRCODE = '22023';
  END IF;

  -- ── Loop annunci ─────────────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_listings) LOOP
    -- validazione semantica: incrementa rejected, mai raise
    IF jsonb_typeof(v_item) <> 'object' THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;

    v_src        := v_item->>'source';
    v_url        := v_item->>'url';
    v_listing_id := v_item->>'listing_id';
    v_title      := coalesce(v_item->>'title','Annuncio');
    v_address    := NULLIF(v_item->>'address','');
    v_agency     := NULLIF(v_item->>'agency_name','');
    v_ptype      := lower(coalesce(v_item->>'property_type','altro'));

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
    IF v_listing_id IS NULL OR v_listing_id = '' THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF NOT (v_ptype = ANY(c_allowed_types)) THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;

    -- numerici: solo numeri o null, senza cast exception
    IF jsonb_typeof(v_item->'price_eur') NOT IN ('number','null') THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF jsonb_typeof(v_item->'surface_sqm') NOT IN ('number','null') THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF jsonb_typeof(v_item->'rooms') NOT IN ('number','null') THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF jsonb_typeof(v_item->'lat') NOT IN ('number','null') THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF jsonb_typeof(v_item->'lng') NOT IN ('number','null') THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF jsonb_typeof(v_item->'is_private') NOT IN ('boolean','null') THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;

    v_price   := NULLIF(v_item->>'price_eur','')::numeric;
    v_surface := NULLIF(v_item->>'surface_sqm','')::numeric;
    v_rooms   := NULLIF(v_item->>'rooms','')::numeric;
    v_lat     := NULLIF(v_item->>'lat','')::double precision;
    v_lng     := NULLIF(v_item->>'lng','')::double precision;
    v_is_priv := coalesce((v_item->>'is_private')::boolean, false);

    -- range check (semantico, no exception)
    IF v_price IS NOT NULL AND (v_price < 1000 OR v_price > 100000000) THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF v_surface IS NOT NULL AND (v_surface < 1 OR v_surface > 10000) THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF v_rooms IS NOT NULL AND (v_rooms < 1 OR v_rooms > 100) THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF v_lat IS NOT NULL AND (v_lat < -90 OR v_lat > 90) THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF v_lng IS NOT NULL AND (v_lng < -180 OR v_lng > 180) THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;

    -- guardia geografica (stessa regola di looksInsidePadova)
    IF v_lat IS NOT NULL AND v_lng IS NOT NULL
       AND NOT (abs(v_lat) < 0.000001 AND abs(v_lng) < 0.000001) THEN
      IF v_lat < 45.34 OR v_lat > 45.48 OR v_lng < 11.78 OR v_lng > 11.98 THEN
        v_rejected := v_rejected + 1; CONTINUE;
      END IF;
    ELSE
      v_txt := lower(coalesce(v_title,'') || ' ' || coalesce(v_address,''));
      IF v_txt ~ '\m(abano|albignasego|rubano|selvazzano|vigonza|cadoneghe|noventa padovana|ponte san nicolo|ponte san nicolò|vicenza|verona|treviso|venezia|rovigo|belluno)\M' THEN
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
                        lower(unaccent(coalesce(v_address,''))),
                        '^(via|viale|v\.le|piazza|p\.zza|piazzale|p\.le|corso|c\.so|largo|vicolo|strada|str\.|borgo|lungargine|riviera|salita)\s+',
                        '', 'i'),
                      '[^a-z0-9]+', '-', 'g'),
                    '^-+|-+$', '', 'g');
    IF v_via_norm <> '' AND v_surface IS NOT NULL AND v_rooms IS NOT NULL THEN
      v_sqm_bkt := (round(v_surface / 5.0) * 5)::int;
      v_cluster_k := v_via_norm || '|' || v_sqm_bkt::text || '|' ||
                     round(v_rooms)::text || '|' || v_ptype;
    ELSE
      v_cluster_k := NULL;
    END IF;

    -- Advisory lock per URL (idempotenza cross-worker)
    PERFORM pg_advisory_xact_lock(hashtextextended(v_url, 0));

    SELECT id, prezzo, prezzo_iniziale, raw_address, lat, lng, mq, locali,
           agency, tipologia, cap, cluster_key
      INTO v_existing_id, v_existing_price, v_existing_initial,
           v_existing_address, v_existing_lat, v_existing_lng,
           v_existing_mq, v_existing_locali, v_existing_agency,
           v_existing_tipologia, v_existing_cap, v_existing_cluster_key
    FROM public.padova_collect_v2_items
    WHERE url = v_url
    ORDER BY id DESC
    LIMIT 1;

    IF v_existing_id IS NULL THEN
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
        CASE WHEN v_is_priv THEN 'PRIVATO' ELSE 'AGENZIA' END,
        CASE WHEN v_agency IS NOT NULL THEN 1 ELSE 0 END,
        v_price, v_price, v_surface, v_rooms, NULL, v_agency, v_ptype,
        v_cluster_k, v_item, 'radar_queue_ingested', now(), 200,
        v_job_ref, 0, now()
      );
      v_created := v_created + 1;
    ELSE
      UPDATE public.padova_collect_v2_items SET
        job_id         = v_job_ref,
        portal         = v_portal_norm,
        listing_id     = coalesce(v_listing_id, listing_id),
        raw_address    = coalesce(v_address, v_title, v_existing_address),
        citta          = 'Padova',
        cap            = coalesce(v_cap, v_existing_cap),
        lat            = coalesce(v_lat, v_existing_lat),
        lng            = coalesce(v_lng, v_existing_lng),
        tipo_lead      = CASE WHEN v_is_priv THEN 'PRIVATO' ELSE 'AGENZIA' END,
        n_agenzie      = CASE WHEN v_agency IS NOT NULL THEN 1 ELSE 0 END,
        prezzo         = coalesce(v_price, v_existing_price),
        prezzo_iniziale = coalesce(v_existing_initial, v_price),
        mq             = coalesce(v_surface, v_existing_mq),
        locali         = coalesce(v_rooms, v_existing_locali),
        bagni          = bagni,
        agency         = coalesce(v_agency, v_existing_agency),
        tipologia      = v_ptype,
        cluster_key    = coalesce(v_cluster_k, v_existing_cluster_key),
        raw_json       = v_item,
        parse_status   = 'radar_queue_ingested',
        processed_at   = now(),
        http_status    = 200,
        log_reason     = v_job_ref,
        updated_at     = now()
      WHERE id = v_existing_id;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  -- ── Promozione (stessa transazione, errori NON assorbiti) ────────
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
$$;

REVOKE ALL ON FUNCTION public.process_padova_portal_collect_v2(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_padova_portal_collect_v2(uuid, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.process_padova_portal_collect_v2(uuid, uuid, jsonb) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.process_padova_portal_collect_v2(uuid, uuid, jsonb) TO service_role;

COMMIT;
