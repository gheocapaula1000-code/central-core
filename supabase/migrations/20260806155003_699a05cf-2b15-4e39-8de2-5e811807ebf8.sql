-- ═══════════════════════════════════════════════════════════════════
-- Civiko One / Padova — perimetro territoriale + matcher contendibili v4
-- Additivo e isolato: nessun altro dominio viene toccato.
-- ═══════════════════════════════════════════════════════════════════

-- 1) TERRITORIO: comune='Padova' solo quando la fonte lo dichiara.
CREATE OR REPLACE FUNCTION public.promote_padova_collect_v2_to_listings(
  p_since timestamptz DEFAULT (now() - '06:00:00'::interval))
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_new int := 0; v_upd int := 0;
  v_idealista_new int := 0; v_idealista_updated int := 0;
  v_now timestamptz := now();
BEGIN
  WITH src AS (
    SELECT DISTINCT ON (portal, url)
      portal, url, raw_address, agency, agency_phone,
      prezzo, mq, locali, bagni, lat, lng,
      public.civiko_classify_tipo_lead(tipo_lead, n_agenzie, agency) AS tipo_lead,
      CASE WHEN public.civiko_resolve_commercial_zone_slug(
             regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')) IS NULL
        THEN NULL
        ELSE regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
      END AS quartiere,
      raw_json
    FROM public.padova_collect_v2_items
    WHERE lower(coalesce(citta,'')) = 'padova'
      AND portal IS NOT NULL AND lower(portal) <> 'idealista'
      AND url IS NOT NULL AND updated_at >= p_since
      AND (prezzo IS NOT NULL OR mq IS NOT NULL)
    ORDER BY portal, url, updated_at DESC
  ),
  ups AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, telefono, tipo_lead, mq, locali, bagni, prezzo,
       lat, lng, indirizzo, quartiere, comune, raw_json, imported_at, last_seen_at)
    SELECT s.portal, s.url, s.agency, s.agency_phone, s.tipo_lead,
      s.mq, s.locali, s.bagni,
      CASE WHEN s.prezzo IS NULL THEN NULL WHEN s.prezzo > 2147483647 THEN NULL ELSE s.prezzo::int END,
      s.lat, s.lng, s.raw_address, s.quartiere, 'Padova', s.raw_json, v_now, v_now
    FROM src s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      telefono = COALESCE(EXCLUDED.telefono, public.padova_listings.telefono),
      tipo_lead = public.civiko_merge_tipo_lead(public.padova_listings.tipo_lead, EXCLUDED.tipo_lead),
      mq = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      quartiere = CASE
        WHEN nullif(trim(coalesce(public.padova_listings.quartiere, '')), '') IS NULL
         AND EXCLUDED.quartiere IS NOT NULL
         AND public.civiko_resolve_commercial_zone_slug(EXCLUDED.quartiere) IN (
               SELECT slug FROM public.civiko_commercial_zones)
        THEN EXCLUDED.quartiere
        ELSE public.padova_listings.quartiere
      END,
      comune = 'Padova',
      raw_json = COALESCE(EXCLUDED.raw_json, public.padova_listings.raw_json),
      last_seen_at = v_now,
      expired_at = NULL
    WHERE (EXCLUDED.prezzo IS NOT NULL OR EXCLUDED.mq IS NOT NULL)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
  INTO v_new, v_upd FROM ups;

  WITH src_id AS (
    SELECT DISTINCT ON (portal, url)
      portal, url, raw_address, agency, agency_phone,
      prezzo, mq, locali, bagni, lat, lng,
      public.civiko_classify_tipo_lead(tipo_lead, n_agenzie, agency) AS tipo_lead,
      CASE WHEN public.civiko_resolve_commercial_zone_slug(
             regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')) IS NULL
        THEN NULL
        ELSE regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
      END AS quartiere,
      raw_json
    FROM public.padova_collect_v2_items
    WHERE lower(coalesce(citta,'')) = 'padova'
      AND lower(portal) = 'idealista' AND url IS NOT NULL AND updated_at >= p_since
      AND (prezzo IS NOT NULL OR mq IS NOT NULL)
    ORDER BY portal, url, updated_at DESC
  ),
  ups_id AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, telefono, tipo_lead, mq, locali, bagni, prezzo,
       lat, lng, indirizzo, quartiere, comune, raw_json, imported_at, last_seen_at)
    SELECT s.portal, s.url, s.agency, s.agency_phone, s.tipo_lead,
      s.mq, s.locali, s.bagni,
      CASE WHEN s.prezzo IS NULL THEN NULL WHEN s.prezzo > 2147483647 THEN NULL ELSE s.prezzo::int END,
      s.lat, s.lng, s.raw_address, s.quartiere, 'Padova', s.raw_json, v_now, v_now
    FROM src_id s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      telefono = COALESCE(EXCLUDED.telefono, public.padova_listings.telefono),
      tipo_lead = public.civiko_merge_tipo_lead(public.padova_listings.tipo_lead, EXCLUDED.tipo_lead),
      mq = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      quartiere = COALESCE(EXCLUDED.quartiere, public.padova_listings.quartiere),
      comune = 'Padova',
      raw_json = COALESCE(EXCLUDED.raw_json, public.padova_listings.raw_json),
      last_seen_at = v_now,
      expired_at = NULL
    WHERE (EXCLUDED.prezzo IS NOT NULL OR EXCLUDED.mq IS NOT NULL)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
  INTO v_idealista_new, v_idealista_updated FROM ups_id;

  RETURN jsonb_build_object(
    'ok', true, 'since', p_since,
    'new', v_new, 'updated', v_upd,
    'idealista_new', v_idealista_new,
    'idealista_updated', v_idealista_updated
  );
END
$fn$;

-- 1b) Risanamento storico idempotente: solo righe attive senza comune e con
--     una fonte reale che dichiara Padova. Nessuna invenzione.
UPDATE public.padova_listings l
   SET comune = 'Padova'
 WHERE l.expired_at IS NULL
   AND l.comune IS NULL
   AND EXISTS (
     SELECT 1 FROM public.padova_collect_v2_items i
      WHERE i.portal = l.fonte AND i.url = l.url
        AND lower(coalesce(i.citta,'')) = 'padova');

-- 2) MATCHER CONTENDIBILI v4 — patch deterministica e asserita del corpo
--    di public.recompute_padova_listings_contendibili(). Ogni sostituzione
--    fallisce con eccezione se l'ancora non esiste (fail-closed).
DO $mig$
DECLARE
  v_src text;
  v_out text;
  v_pos_a int;
  v_pos_b int;
  v_img_block constant text := $blk$  -- ═══════════════════════════════════════════════════════════════════
  -- B-bis) CERTIFICAZIONE FOTOGRAFICA IMAGE_PHASH_V1 — matcher v4
  -- Prova fotografica reale come identità dell'unità: NON richiede la via.
  -- Grafo di coppie certificate; nessuna transitività: ogni coppia del
  -- gruppo deve avere prova diretta (clique completa, max 4 annunci).
  -- Bande prezzo: <=10% con evidenze strutturali compatibili;
  -- 10-15% soltanto con prova forte (>=2 foto condivise + piano e
  -- tipologia dichiarati e uguali + distanza <= 30 m); >15% mai.
  -- ═══════════════════════════════════════════════════════════════════
  CREATE TEMP TABLE _photo_cand_all ON COMMIT DROP AS
  SELECT p.id, p.url, p.fonte, p.mq, p.locali, p.bagni, p.prezzo,
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
         public.civiko_resolve_commercial_zone_slug(p.quartiere) AS czone_slug,
         public.padova_listing_canonical_id(p.url, p.fonte) AS canonical_listing_id,
         COALESCE(p.ev_piano_key, public.padova_unit_floor_key_v2(p.raw_json)) AS piano_k,
         public.padova_unit_tipologia(p.raw_json) AS tipologia,
         public.padova_listing_has_auction_evidence(p.raw_json, p.agency) AS is_asta,
         public.padova_listing_has_mls_exclusive_evidence(p.raw_json) AS is_mls
    FROM public.padova_listings p
   WHERE p.expired_at IS NULL
     AND p.url IS NOT NULL
     AND lower(coalesce(p.comune,'')) = 'padova'
     AND p.agency IS NOT NULL
     AND p.agency <> 'Agenzie'
     AND p.mq IS NOT NULL AND p.mq > 0
     AND p.locali IS NOT NULL
     AND p.prezzo IS NOT NULL AND p.prezzo > 0
     AND lower(coalesce(NULLIF(trim(COALESCE(p.raw_json->>'title',
           p.raw_json->'suggestedTexts'->>'title', p.raw_json->>'subject')), ''), ''))
         ~ '(appartament|casa|villa|villetta|attico|mansarda|loft|monolocale|bilocale|trilocale|quadrilocale|plurilocale|room|flat|rustico|porzione|terreno|ufficio|negozio|house|apartment|duplex|penthouse|villino|familiare)'
     AND EXISTS (
       SELECT 1 FROM public.civiko_listing_photo_pair_evidence e
        WHERE e.evidence_kind = 'IMAGE_PHASH_V1'
          AND (e.listing_a = p.id OR e.listing_b = p.id));

  DELETE FROM _photo_cand_all
   WHERE czone_slug IS NULL
      OR coalesce(agency_key,'') = ''
      OR canonical_listing_id IS NULL
      OR is_asta IS TRUE
      OR is_mls IS TRUE;

  CREATE TEMP TABLE _photo_cand ON COMMIT DROP AS
  SELECT z.id, z.url, z.fonte, z.mq, z.locali, z.bagni, z.prezzo, z.l_last_seen_at,
         z.lat, z.lng, z.quartiere, z.agency_raw, z.agency_key, z.via_n,
         z.czone_slug, z.canonical_listing_id, z.piano_k, z.tipologia
    FROM (
      SELECT d.*, row_number() OVER (
               PARTITION BY d.canonical_listing_id
               ORDER BY d.l_last_seen_at DESC NULLS LAST, d.id DESC) AS _rn
        FROM _photo_cand_all d
    ) z
   WHERE z._rn = 1
     AND NOT EXISTS (SELECT 1 FROM _cert c WHERE z.url = ANY(c.urls))
     AND NOT EXISTS (SELECT 1 FROM _asta_urls a WHERE a.url = z.url)
     AND NOT EXISTS (SELECT 1 FROM _mls_urls m WHERE m.url = z.url);

  -- Coppie ammissibili: prova diretta + compatibilità strutturale + banda prezzo.
  CREATE TEMP TABLE _pe ON COMMIT DROP AS
  SELECT LEAST(x.id, y.id) AS a_id, GREATEST(x.id, y.id) AS b_id,
         e.shared_photos,
         (greatest(x.prezzo, y.prezzo)::numeric
            / NULLIF(least(x.prezzo, y.prezzo), 0)) AS prezzo_ratio
    FROM public.civiko_listing_photo_pair_evidence e
    JOIN _photo_cand x ON x.id = e.listing_a
    JOIN _photo_cand y ON y.id = e.listing_b
   WHERE e.evidence_kind = 'IMAGE_PHASH_V1'
     AND coalesce(e.shared_photos, 0) >= 1
     AND x.id <> y.id
     AND x.czone_slug = y.czone_slug
     AND x.agency_key <> y.agency_key
     AND x.canonical_listing_id <> y.canonical_listing_id
     AND x.locali = y.locali
     AND greatest(x.mq, y.mq)::numeric
           <= greatest(least(x.mq, y.mq)::numeric + 5, least(x.mq, y.mq)::numeric * 1.05)
     AND (x.tipologia IS NULL OR y.tipologia IS NULL OR x.tipologia = y.tipologia)
     AND (x.piano_k IS NULL OR y.piano_k IS NULL OR x.piano_k = y.piano_k)
     AND (x.bagni IS NULL OR y.bagni IS NULL OR x.bagni = y.bagni)
     AND (x.via_n IS NULL OR y.via_n IS NULL OR x.via_n = y.via_n)
     AND (
       greatest(x.prezzo, y.prezzo)::numeric <= least(x.prezzo, y.prezzo)::numeric * 1.10
       OR (
         greatest(x.prezzo, y.prezzo)::numeric <= least(x.prezzo, y.prezzo)::numeric * 1.15
         AND coalesce(e.shared_photos, 0) >= 2
         AND x.piano_k IS NOT NULL AND y.piano_k IS NOT NULL AND x.piano_k = y.piano_k
         AND x.tipologia IS NOT NULL AND y.tipologia IS NOT NULL AND x.tipologia = y.tipologia
         AND x.lat IS NOT NULL AND x.lng IS NOT NULL
         AND y.lat IS NOT NULL AND y.lng IS NOT NULL
         AND public.padova_haversine_m(x.lat, x.lng, y.lat, y.lng) <= 30
       )
     );

  -- Clique complete di dimensione 2..4 (nessuna transitività).
  CREATE TEMP TABLE _photo_cliques ON COMMIT DROP AS
  SELECT ARRAY[p.a_id, p.b_id] AS ids, 2 AS n_rows,
         p.shared_photos::bigint AS foto_condivise, 1::bigint AS n_pairs
    FROM _pe p
  UNION ALL
  SELECT ARRAY[p1.a_id, p1.b_id, p2.b_id], 3,
         (p1.shared_photos + p2.shared_photos + p3.shared_photos)::bigint, 3
    FROM _pe p1
    JOIN _pe p2 ON p2.a_id = p1.a_id AND p2.b_id > p1.b_id
    JOIN _pe p3 ON p3.a_id = p1.b_id AND p3.b_id = p2.b_id
  UNION ALL
  SELECT ARRAY[p1.a_id, p1.b_id, p2.b_id, p3.b_id], 4,
         (p1.shared_photos + p2.shared_photos + p3.shared_photos
          + p4.shared_photos + p5.shared_photos + p6.shared_photos)::bigint, 6
    FROM _pe p1
    JOIN _pe p2 ON p2.a_id = p1.a_id AND p2.b_id > p1.b_id
    JOIN _pe p3 ON p3.a_id = p1.a_id AND p3.b_id > p2.b_id
    JOIN _pe p4 ON p4.a_id = p1.b_id AND p4.b_id = p2.b_id
    JOIN _pe p5 ON p5.a_id = p1.b_id AND p5.b_id = p3.b_id
    JOIN _pe p6 ON p6.a_id = p2.b_id AND p6.b_id = p3.b_id;

  CREATE TEMP TABLE _img_grp ON COMMIT DROP AS
  SELECT 'IMG:' || md5(array_to_string(k.ids, ',')) AS gkey,
         'IMG:' || md5(array_to_string(k.ids, ',')) AS chiave_match,
         k.n_rows, k.n_pairs, k.n_pairs AS n_pairs_ok, k.foto_condivise,
         min(m.czone_slug) AS czone_slug,
         (array_agg(m.via_n) FILTER (WHERE m.via_n IS NOT NULL))[1] AS via_n,
         min(m.locali) AS locali,
         count(DISTINCT m.canonical_listing_id) AS n_annunci_canonici,
         count(DISTINCT m.agency_key) AS n_agenzie,
         count(DISTINCT m.fonte) AS n_portali,
         count(DISTINCT m.czone_slug) AS n_zone,
         count(DISTINCT m.locali) AS n_locali,
         min(m.mq) AS mq_min, max(m.mq) AS mq_max,
         min(m.prezzo) AS prezzo_min, max(m.prezzo) AS prezzo_max,
         count(DISTINCT m.bagni) FILTER (WHERE m.bagni IS NOT NULL) AS n_bagni,
         count(DISTINCT m.piano_k) FILTER (WHERE m.piano_k IS NOT NULL) AS n_piani,
         count(DISTINCT m.tipologia) FILTER (WHERE m.tipologia IS NOT NULL) AS n_tipologie,
         round(avg(m.mq))::int AS mq_avg,
         (array_agg(m.bagni) FILTER (WHERE m.bagni IS NOT NULL))[1] AS bagni_pick,
         array_agg(DISTINCT m.agency_raw ORDER BY m.agency_raw) AS agenzie,
         array_agg(DISTINCT m.fonte ORDER BY m.fonte) AS fonti,
         array_agg(m.url ORDER BY m.url) AS urls,
         (array_agg(m.quartiere) FILTER (WHERE m.quartiere IS NOT NULL))[1] AS quartiere,
         avg(m.lat) FILTER (WHERE m.lat IS NOT NULL) AS lat,
         avg(m.lng) FILTER (WHERE m.lng IS NOT NULL) AS lng,
         max(m.l_last_seen_at) AS last_seen_at,
         (array_agg(m.piano_k) FILTER (WHERE m.piano_k IS NOT NULL))[1] AS piano_pick
    FROM _photo_cliques k
    JOIN _photo_cand m ON m.id = ANY(k.ids)
   GROUP BY k.ids, k.n_rows, k.n_pairs, k.foto_condivise;

  SELECT count(*) INTO v_img_groups_examined FROM _img_grp;

  CREATE TEMP TABLE _img_ok ON COMMIT DROP AS
  SELECT g.*
    FROM _img_grp g
   WHERE g.n_zone = 1
     AND g.n_locali = 1
     AND g.n_agenzie >= 2
     AND g.n_annunci_canonici >= 2
     AND g.n_annunci_canonici = g.n_rows
     AND g.n_rows BETWEEN 2 AND 4
     AND g.mq_min > 0
     AND g.mq_max::numeric <= greatest(g.mq_min::numeric + 5, g.mq_min::numeric * 1.05)
     AND g.prezzo_min > 0
     AND g.prezzo_max::numeric <= g.prezzo_min::numeric * 1.15
     AND g.n_bagni <= 1
     AND g.n_piani <= 1
     AND g.n_tipologie <= 1;

  -- esclusività degli annunci: un annuncio in un solo gruppo fotografico
  CREATE TEMP TABLE _img_cert (LIKE _img_ok) ON COMMIT DROP;
  CREATE TEMP TABLE _img_cert_urls (url text PRIMARY KEY) ON COMMIT DROP;

  FOR r IN
    SELECT * FROM _img_ok
     ORDER BY n_rows DESC, n_agenzie DESC, foto_condivise DESC, chiave_match
  LOOP
    IF NOT EXISTS (SELECT 1 FROM _img_cert_urls cu WHERE cu.url = ANY(r.urls)) THEN
      INSERT INTO _img_cert SELECT * FROM _img_ok u WHERE u.gkey = r.gkey;
      INSERT INTO _img_cert_urls SELECT DISTINCT unnest(r.urls) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_img_cert FROM _img_cert;$blk$;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'recompute_padova_listings_contendibili';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'recompute_padova_listings_contendibili assente';
  END IF;

  -- (A) nuove variabili di conteggio
  IF position('v_mls_rows' in v_src) = 0 THEN
    v_out := replace(v_src,
      E'  v_asta_rows int := 0;\n  v_asta_groups int := 0;',
      E'  v_asta_rows int := 0;\n  v_asta_groups int := 0;\n  v_mls_rows int := 0;\n  v_mls_groups int := 0;\n  v_zone_counts int := 0;');
    IF v_out = v_src THEN RAISE EXCEPTION 'patch A: ancora non trovata'; END IF;
    v_src := v_out;
  END IF;

  -- (B) insieme URL con prova MLS/esclusiva
  IF position('_mls_urls' in v_src) = 0 THEN
    v_out := replace(v_src,
      E'  SELECT count(*) INTO v_asta_rows FROM _asta_urls;',
      E'  SELECT count(*) INTO v_asta_rows FROM _asta_urls;\n\n  CREATE TEMP TABLE _mls_urls ON COMMIT DROP AS\n  SELECT DISTINCT c.url\n  FROM _cand c\n  JOIN public.padova_listings l ON l.id = c.id\n  WHERE public.padova_listing_has_mls_exclusive_evidence(l.raw_json);\n  SELECT count(*) INTO v_mls_rows FROM _mls_urls;');
    IF v_out = v_src THEN RAISE EXCEPTION 'patch B: ancora non trovata'; END IF;
    v_src := v_out;
  END IF;

  -- (C) esclusione MLS dai gruppi strutturali
  IF position('v_mls_groups FROM _unit_grp' in v_src) = 0 THEN
    v_out := replace(v_src,
      E'  DELETE FROM _unit_grp g\n   WHERE EXISTS (SELECT 1 FROM _asta_urls a WHERE a.url = ANY(g.urls));',
      E'  DELETE FROM _unit_grp g\n   WHERE EXISTS (SELECT 1 FROM _asta_urls a WHERE a.url = ANY(g.urls));\n\n  SELECT count(*) INTO v_mls_groups FROM _unit_grp g\n   WHERE EXISTS (SELECT 1 FROM _mls_urls m WHERE m.url = ANY(g.urls));\n  DELETE FROM _unit_grp g\n   WHERE EXISTS (SELECT 1 FROM _mls_urls m WHERE m.url = ANY(g.urls));');
    IF v_out = v_src THEN RAISE EXCEPTION 'patch C: ancora non trovata'; END IF;
    v_src := v_out;
  END IF;

  -- (D) banda prezzo percorso strutturale: 35% -> 10%
  v_out := replace(v_src,
    E'    AND prezzo_max::numeric <= prezzo_min::numeric * 1.35\n    AND n_bagni <= 1',
    E'    AND prezzo_max::numeric <= prezzo_min::numeric * 1.10\n    AND n_bagni <= 1');
  IF v_out = v_src AND position(E'AND prezzo_max::numeric <= prezzo_min::numeric * 1.10' in v_src) = 0 THEN
    RAISE EXCEPTION 'patch D: ancora non trovata';
  END IF;
  v_src := v_out;

  -- (E) QA staging strutturale: 35% -> 10%
  v_out := replace(v_src,
    E'      OR prezzo_max::numeric > prezzo_min::numeric * 1.35\n      OR mq_max::numeric',
    E'      OR prezzo_max::numeric > prezzo_min::numeric * 1.10\n      OR mq_max::numeric');
  IF v_out = v_src AND position(E'OR prezzo_max::numeric > prezzo_min::numeric * 1.10' in v_src) = 0 THEN
    RAISE EXCEPTION 'patch E: ancora non trovata';
  END IF;
  v_src := v_out;

  -- (F) QA post-scrittura: banda massima assoluta 15%
  v_out := replace(v_src,
    E'      OR prezzo_max::numeric > prezzo_min::numeric * 1.35\n      OR commercial_zone_slug IS NULL;',
    E'      OR prezzo_max::numeric > prezzo_min::numeric * 1.15\n      OR commercial_zone_slug IS NULL;');
  IF v_out = v_src AND position(E'OR prezzo_max::numeric > prezzo_min::numeric * 1.15' in v_src) = 0 THEN
    RAISE EXCEPTION 'patch F: ancora non trovata';
  END IF;
  v_src := v_out;

  -- (G) QA MLS e perimetro Padova/8 zone
  IF position('QA MLS fallita' in v_src) = 0 THEN
    v_out := replace(v_src,
      E'    RAISE EXCEPTION \'QA aste fallita: % contendibili con evidenza asta\', v_bad;\n  END IF;',
      E'    RAISE EXCEPTION \'QA aste fallita: % contendibili con evidenza asta\', v_bad;\n  END IF;\n\n  SELECT count(*) INTO v_bad\n    FROM public.padova_contendibili pc\n   WHERE EXISTS (\n     SELECT 1 FROM public.padova_listings l\n      WHERE l.url = ANY(pc.urls)\n        AND public.padova_listing_has_mls_exclusive_evidence(l.raw_json));\n  IF v_bad > 0 THEN\n    RAISE EXCEPTION \'QA MLS fallita: % contendibili con prova MLS/esclusiva\', v_bad;\n  END IF;\n\n  SELECT count(*) INTO v_bad\n    FROM public.padova_contendibili pc\n   WHERE pc.commercial_zone_slug IS NULL\n      OR NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z\n                      WHERE z.slug = pc.commercial_zone_slug)\n      OR EXISTS (\n        SELECT 1 FROM public.padova_listings l\n         WHERE l.url = ANY(pc.urls)\n           AND lower(coalesce(l.comune,\'\')) <> \'padova\');\n  IF v_bad > 0 THEN\n    RAISE EXCEPTION \'QA perimetro Padova/8 zone fallita: % contendibili fuori perimetro\', v_bad;\n  END IF;');
    IF v_out = v_src THEN RAISE EXCEPTION 'patch G: ancora non trovata'; END IF;
    v_src := v_out;
  END IF;

  -- (H) conteggi ufficiali per zona derivati dallo stato corrente
  IF position('v_zone_counts = ROW_COUNT' in v_src) = 0 THEN
    v_out := replace(v_src,
      E'  SELECT count(*) INTO v_cont_after FROM public.padova_contendibili;',
      E'  UPDATE public.civiko_commercial_zones z\n     SET contendibili_count = COALESCE(c.n, 0)\n    FROM (SELECT s.slug, count(pc.chiave_match) AS n\n            FROM public.civiko_commercial_zones s\n            LEFT JOIN public.padova_contendibili pc\n              ON pc.commercial_zone_slug = s.slug\n           GROUP BY s.slug) c\n   WHERE c.slug = z.slug\n     AND z.contendibili_count IS DISTINCT FROM COALESCE(c.n, 0);\n  GET DIAGNOSTICS v_zone_counts = ROW_COUNT;\n\n  SELECT count(*) INTO v_cont_after FROM public.padova_contendibili;');
    IF v_out = v_src THEN RAISE EXCEPTION 'patch H: ancora non trovata'; END IF;
    v_src := v_out;
  END IF;

  -- (I) diagnostica di ritorno
  IF position('mls_annunci_esclusi' in v_src) = 0 THEN
    v_out := replace(v_src,
      E'    \'aste_gruppi_esclusi\', v_asta_groups,',
      E'    \'aste_gruppi_esclusi\', v_asta_groups,\n    \'mls_annunci_esclusi\', v_mls_rows,\n    \'mls_gruppi_esclusi\', v_mls_groups,\n    \'zone_counts_aggiornate\', v_zone_counts,');
    IF v_out = v_src THEN RAISE EXCEPTION 'patch I: ancora non trovata'; END IF;
    v_src := v_out;
  END IF;

  -- (J) sostituzione integrale del blocco fotografico B-bis
  IF position('_photo_cliques' in v_src) = 0 THEN
    v_pos_a := position(E'  -- ═══════════════════════════════════════════════════════════════════\n  -- B-bis)' in v_src);
    IF v_pos_a = 0 THEN RAISE EXCEPTION 'patch J: ancora iniziale non trovata'; END IF;
    v_pos_b := position(E'  SELECT count(*) INTO v_img_cert FROM _img_cert;' in v_src);
    IF v_pos_b = 0 OR v_pos_b <= v_pos_a THEN RAISE EXCEPTION 'patch J: ancora finale non trovata'; END IF;
    v_src := left(v_src, v_pos_a - 1)
           || v_img_block
           || substr(v_src, v_pos_b + length(E'  SELECT count(*) INTO v_img_cert FROM _img_cert;'));
  END IF;

  EXECUTE 'CREATE OR REPLACE FUNCTION public.recompute_padova_listings_contendibili() '
       || 'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS '
       || '$fn$' || v_src || '$fn$';
END
$mig$;

-- 3) Allineamento immediato dei conteggi ufficiali per zona.
UPDATE public.civiko_commercial_zones z
   SET contendibili_count = COALESCE(c.n, 0)
  FROM (SELECT s.slug, count(pc.chiave_match) AS n
          FROM public.civiko_commercial_zones s
          LEFT JOIN public.padova_contendibili pc
            ON pc.commercial_zone_slug = s.slug
         GROUP BY s.slug) c
 WHERE c.slug = z.slug;