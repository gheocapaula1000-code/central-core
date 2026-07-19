-- ============================================================================
-- Fase 1A shadow mode — process_padova_portal_collect_v2
-- Non applicare automaticamente.
-- Prerequisiti:
--   - public.scraping_queue e scraping_enqueue_processed già esistenti
--   - public.padova_collect_v2_items già esistente
--   - public.promote_padova_collect_v2_to_listings(timestamptz) già esistente
-- Effetti: aggiunge SOLO la RPC process_padova_portal_collect_v2.
-- Nessuna modifica strutturale a tabelle esistenti.
-- Nessun indice UNIQUE nuovo su padova_collect_v2_items (duplicati storici
-- potenzialmente presenti — verifica preventiva richiesta prima di aggiungere
-- vincoli globali).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.process_padova_portal_collect_v2(
  p_queue_id  uuid,
  p_context   jsonb,
  p_listings  jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_provider  text;
  v_operation text;
  v_status    text;
  v_processor text;
  v_muni      text := p_context->>'municipality';
  v_prov      text := p_context->>'province';
  v_portal    text := p_context->>'portal';
  v_mode      text := p_context->>'mode';
  v_job_ref   text := 'radar_queue:' || p_queue_id::text;
  v_len       int;
  v_item      jsonb;
  v_url       text;
  v_listing_id text;
  v_title     text;
  v_address   text;
  v_price     numeric;
  v_surface   int;
  v_rooms     int;
  v_agency    text;
  v_lat       double precision;
  v_lng       double precision;
  v_is_priv   boolean;
  v_existing_id bigint;
  v_existing_price numeric;
  v_existing_initial numeric;
  v_created  int := 0;
  v_updated  int := 0;
  v_rejected int := 0;
  v_errors   int := 0;
  v_promote  jsonb;
BEGIN
  -- Validazione job esistente e coerente
  SELECT provider::text, operation, status, processor
    INTO v_provider, v_operation, v_status, v_processor
  FROM public.scraping_queue
  WHERE id = p_queue_id;

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

  -- Validazione context
  IF v_muni IS DISTINCT FROM 'Padova' THEN
    RAISE EXCEPTION 'invalid_municipality' USING ERRCODE = '22023';
  END IF;
  IF v_prov IS DISTINCT FROM 'PD' THEN
    RAISE EXCEPTION 'invalid_province' USING ERRCODE = '22023';
  END IF;
  IF v_portal NOT IN ('immobiliare.it','idealista.it','casa.it','subito.it') THEN
    RAISE EXCEPTION 'invalid_portal:%', v_portal USING ERRCODE = '22023';
  END IF;
  IF v_mode NOT IN ('soft','full') THEN
    RAISE EXCEPTION 'invalid_mode:%', v_mode USING ERRCODE = '22023';
  END IF;

  -- Validazione payload
  IF jsonb_typeof(p_listings) <> 'array' THEN
    RAISE EXCEPTION 'listings_not_array' USING ERRCODE = '22023';
  END IF;
  v_len := jsonb_array_length(p_listings);
  IF v_len > 100 THEN
    RAISE EXCEPTION 'listings_over_cap:%', v_len USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_listings) LOOP
    BEGIN
      v_url := left(coalesce(v_item->>'url',''), 400);
      v_listing_id := left(coalesce(v_item->>'listing_id',''), 200);
      IF v_url IS NULL OR v_url = '' OR v_url !~* '^https?://' THEN
        v_rejected := v_rejected + 1;
        CONTINUE;
      END IF;
      IF v_listing_id IS NULL OR v_listing_id = '' THEN
        v_rejected := v_rejected + 1;
        CONTINUE;
      END IF;

      v_title    := left(coalesce(v_item->>'title','Annuncio'), 200);
      v_address  := NULLIF(left(coalesce(v_item->>'address',''), 200), '');
      v_price    := NULLIF(v_item->>'price_eur','')::numeric;
      v_surface  := NULLIF(v_item->>'surface_sqm','')::int;
      v_rooms    := NULLIF(v_item->>'rooms','')::int;
      v_agency   := NULLIF(left(coalesce(v_item->>'agency_name',''), 150), '');
      v_lat      := NULLIF(v_item->>'lat','')::double precision;
      v_lng      := NULLIF(v_item->>'lng','')::double precision;
      v_is_priv  := (v_item->>'is_private')::boolean;

      -- Advisory lock per URL (evita race su medesimo annuncio)
      PERFORM pg_advisory_xact_lock(hashtextextended(v_url, 0));

      SELECT id, prezzo, prezzo_iniziale
        INTO v_existing_id, v_existing_price, v_existing_initial
      FROM public.padova_collect_v2_items
      WHERE url = v_url
      LIMIT 1;

      IF v_existing_id IS NULL THEN
        INSERT INTO public.padova_collect_v2_items (
          job_id, portal, listing_id, url, raw_address, citta,
          lat, lng, prezzo, prezzo_iniziale, mq, locali, agency,
          tipologia, raw_json, parse_status, processed_at, http_status,
          log_reason, attempts, created_at
        ) VALUES (
          v_job_ref, v_portal, v_listing_id, v_url, v_address, 'Padova',
          v_lat, v_lng, v_price, v_price, v_surface, v_rooms, v_agency,
          left(v_title, 200), v_item, 'radar_queue_ingested', now(), 200,
          v_job_ref, 0, now()
        );
        v_created := v_created + 1;
      ELSE
        UPDATE public.padova_collect_v2_items SET
          job_id         = v_job_ref,
          portal         = v_portal,
          listing_id     = coalesce(v_listing_id, listing_id),
          raw_address    = coalesce(v_address, raw_address),
          citta          = coalesce(citta, 'Padova'),
          lat            = coalesce(v_lat, lat),
          lng            = coalesce(v_lng, lng),
          prezzo         = coalesce(v_price, prezzo),
          -- Preserva prezzo_iniziale se già presente
          prezzo_iniziale = coalesce(v_existing_initial, v_price, prezzo_iniziale),
          mq             = coalesce(v_surface, mq),
          locali         = coalesce(v_rooms, locali),
          agency         = coalesce(v_agency, agency),
          tipologia      = coalesce(left(v_title, 200), tipologia),
          raw_json       = coalesce(v_item, raw_json),
          parse_status   = 'radar_queue_ingested',
          processed_at   = now(),
          http_status    = 200,
          log_reason     = v_job_ref,
          updated_at     = now()
        WHERE id = v_existing_id;
        v_updated := v_updated + 1;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      -- Log leggibile, senza dati sensibili
      RAISE NOTICE 'process_padova_portal_collect_v2 item_error url=% code=% msg=%',
        left(v_url, 100), SQLSTATE, SQLERRM;
    END;
  END LOOP;

  -- Promozione (stessa transazione)
  BEGIN
    v_promote := public.promote_padova_collect_v2_to_listings(now() - interval '6 hours');
  EXCEPTION WHEN OTHERS THEN
    v_promote := jsonb_build_object('error', SQLSTATE, 'message', SQLERRM);
  END;

  RETURN jsonb_build_object(
    'queue_id', p_queue_id,
    'portal', v_portal,
    'mode', v_mode,
    'received', v_len,
    'created', v_created,
    'updated', v_updated,
    'rejected', v_rejected,
    'errors', v_errors,
    'promote', v_promote
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_padova_portal_collect_v2(uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_padova_portal_collect_v2(uuid, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.process_padova_portal_collect_v2(uuid, jsonb, jsonb) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.process_padova_portal_collect_v2(uuid, jsonb, jsonb) TO service_role;

COMMIT;
