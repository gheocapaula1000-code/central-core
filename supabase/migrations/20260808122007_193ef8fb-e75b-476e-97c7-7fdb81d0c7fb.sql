CREATE OR REPLACE FUNCTION public.civiko_padova_matcher_v4_candidates()
 RETURNS TABLE(id bigint, url text, fonte text, mq integer, locali integer, bagni integer, prezzo bigint, l_last_seen_at timestamp with time zone, lat double precision, lng double precision, quartiere text, agency_raw text, agency_key text, via_n text, civico_n text, czone_slug text, canonical_listing_id text, piano_k text, tipologia text, descr_fp text, identity_key text, is_asta boolean, is_mls boolean, title_type_ok boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- BASE MINIMA (valida per il ramo PHOTO): attivo, Comune Padova esatto,
  -- commercial_zone_slug PERSISTITO tra le 8 zone ufficiali (contratto v2),
  -- url + canonical distinta, agenzia normalizzata nota, prezzo > 0,
  -- nessuna asta/MLS.
  WITH base AS MATERIALIZED (
    SELECT p.id::bigint AS id, p.url, p.fonte, p.mq::int AS mq, p.locali::int AS locali,
           p.bagni::int AS bagni, p.prezzo::bigint AS prezzo,
           p.last_seen_at AS l_last_seen_at,
           CASE WHEN p.lat BETWEEN 45.30 AND 45.50 THEN p.lat END AS lat,
           CASE WHEN p.lng BETWEEN 11.75 AND 12.00 THEN p.lng END AS lng,
           p.quartiere,
           p.agency AS agency_raw,
           COALESCE(
             NULLIF(public.norm_agency(regexp_replace(lower(trim(p.agency)),
               '^(agenzia immobiliare|immobiliare)\s+', '', 'g')), ''),
             public.norm_agency(p.agency)
           ) AS agency_key,
           COALESCE(p.ev_via_norm, public.padova_via_key(p.indirizzo)) AS via_n,
           COALESCE(p.ev_civico_norm, '') AS civico_n,
           p.commercial_zone_slug AS czone_slug,
           public.padova_listing_canonical_id(p.url, p.fonte) AS canonical_listing_id,
           COALESCE(p.ev_piano_key, public.padova_unit_floor_key_v2(p.raw_json)) AS piano_k,
           public.padova_unit_tipologia(p.raw_json) AS tipologia,
           COALESCE(p.ev_descr_fp,
             CASE WHEN length(regexp_replace(lower(COALESCE(p.raw_json->>'description', p.raw_json->>'body','')), '[^a-z0-9]+','','g')) >= 160
                  THEN md5(left(regexp_replace(lower(COALESCE(p.raw_json->>'description', p.raw_json->>'body','')), '[^a-z0-9]+','','g'), 400))
             END) AS descr_fp,
           public.padova_listing_has_auction_evidence(p.raw_json, p.agency) AS is_asta,
           public.padova_listing_has_mls_exclusive_evidence(p.raw_json) AS is_mls,
           (lower(coalesce(NULLIF(trim(COALESCE(p.raw_json->>'title',
               p.raw_json->'suggestedTexts'->>'title', p.raw_json->>'subject')), ''), ''))
             ~ '(appartament|casa|villa|villetta|attico|mansarda|loft|monolocale|bilocale|trilocale|quadrilocale|plurilocale|room|flat|rustico|porzione|terreno|ufficio|negozio|house|apartment|duplex|penthouse|villino|familiare)')
             AS title_type_ok
      FROM public.padova_listings p
     WHERE p.expired_at IS NULL
       AND p.url IS NOT NULL
       AND p.comune = 'Padova'
       AND p.agency IS NOT NULL
       AND p.agency <> 'Agenzie'
       AND p.prezzo IS NOT NULL AND p.prezzo > 0
       AND public.civiko_is_official_zone_slug(p.commercial_zone_slug)
  ),
  filtered AS (
    SELECT b.*
      FROM base b
     WHERE coalesce(b.agency_key,'') <> ''
       AND b.canonical_listing_id IS NOT NULL
       AND b.is_asta IS NOT TRUE
       AND b.is_mls IS NOT TRUE
  ),
  dedup AS (
    SELECT f.*, row_number() OVER (
             PARTITION BY f.canonical_listing_id
             ORDER BY f.l_last_seen_at DESC NULLS LAST, f.id DESC) AS rn
      FROM filtered f
  )
  SELECT d.id, d.url, d.fonte, d.mq, d.locali, d.bagni, d.prezzo, d.l_last_seen_at,
         d.lat, d.lng, d.quartiere, d.agency_raw, d.agency_key, d.via_n, d.civico_n,
         d.czone_slug, d.canonical_listing_id, d.piano_k, d.tipologia, d.descr_fp,
         CASE WHEN d.locali IS NULL THEN NULL
              WHEN coalesce(d.civico_n,'') <> ''
              THEN d.czone_slug || '|C:' || d.civico_n || '|L:' || d.locali::text
              WHEN d.via_n IS NOT NULL
              THEN d.czone_slug || '|V:' || d.via_n || '|L:' || d.locali::text
         END AS identity_key,
         d.is_asta, d.is_mls, d.title_type_ok
    FROM dedup d
   WHERE d.rn = 1;
$function$;

CREATE OR REPLACE FUNCTION public.process_civiko_contendibile_detail_v1(p_queue_id uuid, p_worker_id uuid, p_listing_id bigint, p_url text, p_commercial_zone_slug text, p_evidence jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '15s'
 SET lock_timeout TO '3s'
AS $function$
DECLARE
  v_listing public.padova_listings%ROWTYPE;
  v_attempt public.civiko_contendibili_evidence_attempts%ROWTYPE;
  v_via text := NULLIF(btrim(p_evidence->>'via_norm'), '');
  v_civico text := NULLIF(lower(btrim(p_evidence->>'civico_norm')), '');
  v_piano text := NULLIF(upper(btrim(p_evidence->>'piano_key')), '');
  v_descr text := NULLIF(lower(btrim(p_evidence->>'descr_fp')), '');
  v_images jsonb := COALESCE(p_evidence->'image_refs', '[]'::jsonb);
  v_has_civico boolean := false;
  v_has_piano boolean := false;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_queue_id IS NULL OR p_worker_id IS NULL OR p_listing_id IS NULL THEN
    RAISE EXCEPTION 'invalid processor identity';
  END IF;
  IF NOT public.civiko_is_official_zone_slug(p_commercial_zone_slug) THEN
    RAISE EXCEPTION 'invalid commercial zone';
  END IF;
  IF p_url IS NULL OR p_url !~ '^https://' OR length(p_url) > 500 THEN
    RAISE EXCEPTION 'invalid url';
  END IF;
  IF jsonb_typeof(COALESCE(p_evidence,'{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'invalid evidence';
  END IF;
  IF v_via IS NOT NULL AND (length(v_via) > 200 OR public.padova_via_key(v_via) IS NULL) THEN
    RAISE EXCEPTION 'invalid via evidence';
  END IF;
  IF v_civico IS NOT NULL AND v_civico !~ '^[0-9]{1,3}[a-z]?$' THEN
    RAISE EXCEPTION 'invalid civico evidence';
  END IF;
  IF v_piano IS NOT NULL AND v_piano !~ '^(S|R|T|M|A|P([1-9]|[1-3][0-9]|40))$' THEN
    RAISE EXCEPTION 'invalid piano evidence';
  END IF;
  IF v_descr IS NOT NULL AND v_descr !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid description fingerprint';
  END IF;
  IF jsonb_typeof(v_images) <> 'array' OR jsonb_array_length(v_images) > 12 THEN
    RAISE EXCEPTION 'invalid image references';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_images) x
    WHERE x !~ '^https://' OR length(x) > 500
  ) THEN
    RAISE EXCEPTION 'invalid image reference';
  END IF;

  SELECT * INTO v_listing
  FROM public.padova_listings
  WHERE id = p_listing_id
  FOR UPDATE;
  IF NOT FOUND OR v_listing.url IS DISTINCT FROM p_url
     OR v_listing.commercial_zone_slug IS DISTINCT FROM p_commercial_zone_slug
     OR v_listing.expired_at IS NOT NULL THEN
    RAISE EXCEPTION 'listing scope mismatch';
  END IF;

  SELECT * INTO v_attempt
  FROM public.civiko_contendibili_evidence_attempts
  WHERE listing_id = p_listing_id
  FOR UPDATE;
  IF NOT FOUND OR v_attempt.queue_id IS DISTINCT FROM p_queue_id
     OR v_attempt.commercial_zone_slug IS DISTINCT FROM p_commercial_zone_slug THEN
    RAISE EXCEPTION 'attempt scope mismatch';
  END IF;

  UPDATE public.padova_listings l
     SET ev_via_norm = CASE
           WHEN v_via IS NULL THEN l.ev_via_norm
           WHEN l.ev_via_norm IS NULL OR l.ev_via_norm = v_via THEN v_via
           ELSE NULL
         END,
         ev_civico_norm = CASE
           WHEN v_civico IS NULL THEN l.ev_civico_norm
           WHEN l.ev_civico_norm IS NULL OR l.ev_civico_norm = v_civico THEN v_civico
           ELSE NULL
         END,
         ev_piano_key = CASE
           WHEN v_piano IS NULL THEN l.ev_piano_key
           WHEN l.ev_piano_key IS NULL OR l.ev_piano_key = v_piano THEN v_piano
           ELSE NULL
         END,
         ev_descr_fp = COALESCE(v_descr, l.ev_descr_fp),
         ev_image_refs = CASE
           WHEN jsonb_array_length(v_images) > 0 THEN v_images
           ELSE l.ev_image_refs
         END,
         ev_provenance = COALESCE(l.ev_provenance, '{}'::jsonb) ||
           jsonb_build_object(
             'detail', jsonb_strip_nulls(jsonb_build_object(
               'version', COALESCE(p_evidence->>'version','civiko-detail-v1'),
               'queue_id', p_queue_id,
               'derived_at', now(),
               'via', v_via,
               'civico', v_civico,
               'piano', v_piano,
               'description_fingerprint', v_descr,
               'unit_ref', NULLIF(p_evidence->>'unit_ref',''),
               'image_count', jsonb_array_length(v_images),
               'text_chars', COALESCE((p_evidence->>'text_chars')::int,0)
             ))
           ),
         ev_derived_at = now()
   WHERE l.id = p_listing_id;

  SELECT ev_civico_norm IS NOT NULL, ev_piano_key IS NOT NULL
    INTO v_has_civico, v_has_piano
    FROM public.padova_listings WHERE id = p_listing_id;

  UPDATE public.civiko_contendibili_evidence_attempts
     SET status = 'succeeded',
         evidence = jsonb_strip_nulls(p_evidence),
         error_code = NULL,
         completed_at = now(),
         updated_at = now()
   WHERE listing_id = p_listing_id;

  IF v_attempt.run_id IS NOT NULL THEN
    UPDATE public.civiko_contendibili_evidence_runs
       SET processed = processed + 1,
           evidence_with_civico = evidence_with_civico + CASE WHEN v_has_civico THEN 1 ELSE 0 END,
           evidence_with_piano = evidence_with_piano + CASE WHEN v_has_piano THEN 1 ELSE 0 END
     WHERE id = v_attempt.run_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'listing_id', p_listing_id,
    'commercial_zone_slug', p_commercial_zone_slug,
    'has_civico', v_has_civico,
    'has_piano', v_has_piano,
    'image_refs', jsonb_array_length(v_images)
  );
END;
$function$;