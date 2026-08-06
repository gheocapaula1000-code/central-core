-- 20260806040000_civiko_contendibili_image_phash_v1_wiring.sql
-- Collega end-to-end la prova fotografica (IMAGE_PHASH_V1) al percorso Civiko
-- dei contendibili. Additivo e isolato a Civiko/Padova: nessuna soglia
-- strutturale, filtro aste/MLS, zona, RLS o contratto feed viene modificato.

-- 1) Fingerprint percettivi calcolati sui BYTE reali (mai su URL/filename).
CREATE TABLE IF NOT EXISTS public.civiko_listing_image_fingerprints (
  listing_id   bigint NOT NULL,
  sha256       text   NOT NULL,
  phash        text   NOT NULL,
  width        int    NOT NULL,
  height       int    NOT NULL,
  bytes        int    NOT NULL,
  entropy      numeric NOT NULL,
  algo         text   NOT NULL,
  source_host  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, sha256)
);

GRANT ALL ON public.civiko_listing_image_fingerprints TO service_role;
ALTER TABLE public.civiko_listing_image_fingerprints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only_image_fingerprints"
  ON public.civiko_listing_image_fingerprints;
CREATE POLICY "service_role_only_image_fingerprints"
  ON public.civiko_listing_image_fingerprints
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS civiko_listing_image_fp_phash_idx
  ON public.civiko_listing_image_fingerprints (phash);

-- 2) Prova per COPPIA di annunci: >= 2 fotografie reali condivise.
CREATE TABLE IF NOT EXISTS public.civiko_listing_photo_pair_evidence (
  listing_a      bigint NOT NULL,
  listing_b      bigint NOT NULL,
  agency_a       text   NOT NULL,
  agency_b       text   NOT NULL,
  shared_photos  int    NOT NULL,
  distances      jsonb  NOT NULL DEFAULT '[]'::jsonb,
  algo           text   NOT NULL,
  soglia         int    NOT NULL,
  match_version  text   NOT NULL,
  evidence_kind  text   NOT NULL,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_a, listing_b),
  CONSTRAINT civiko_photo_pair_order CHECK (listing_a < listing_b),
  CONSTRAINT civiko_photo_pair_agency CHECK (agency_a <> agency_b),
  CONSTRAINT civiko_photo_pair_shared CHECK (shared_photos >= 1)
);

GRANT ALL ON public.civiko_listing_photo_pair_evidence TO service_role;
ALTER TABLE public.civiko_listing_photo_pair_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only_photo_pair_evidence"
  ON public.civiko_listing_photo_pair_evidence;
CREATE POLICY "service_role_only_photo_pair_evidence"
  ON public.civiko_listing_photo_pair_evidence
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS civiko_photo_pair_b_idx
  ON public.civiko_listing_photo_pair_evidence (listing_b);

-- 3) Recompute autoritativo: consuma la prova fotografica come SECONDA via di
--    certificazione (image-phash-v1-wiring), mantenendo intatto
--    canonical-listing-dedup-v1 (>= 2 annunci canonici, >= 2 agenzie reali).

-- 3) Recompute autoritativo: la definizione CORRENTE viene patchata in modo
--    deterministico e verificabile. Ogni ancora mancante fa fallire la
--    migrazione (fail closed): nessuna soglia strutturale, filtro aste/MLS,
--    zona o QA esistente viene rimossa. In particolare restano intatti
--    canonical-listing-dedup-v1 e la QA
--    'QA identita canonica fallita: % contendibili con meno di 2 annunci canonici distinti'.
DO $mig$
DECLARE
  v_src text;
  v_old text;
  v_new text;
  v_pairs text[][] := ARRAY[
    [$q$  v_match_version constant text := 'v3-unit-certified';$q$, $q$  v_match_version constant text := 'v3-unit-certified';
  -- image-phash-v1: seconda via di certificazione, additiva e mai sostitutiva
  v_img_match_version constant text := 'v3-unit-certified+image-phash-v1';
  v_img_groups_examined int := 0;
  v_img_cert int := 0;$q$],
    [$q$  -- ═══════════════════════════════════════════════════════════════════
  -- C) QA SULLO STAGING — nessuna scrittura se un controllo fallisce
  -- ═══════════════════════════════════════════════════════════════════$q$, $q$  -- ═══════════════════════════════════════════════════════════════════
  -- B-bis) CERTIFICAZIONE FOTOGRAFICA IMAGE_PHASH_V1 (additiva)
  -- Consuma le prove per coppia gia' persistite da
  -- civiko-contendibili-image-certify. Nessuna transitivita': OGNI coppia
  -- cross-agenzia del gruppo deve condividere >= 2 fotografie reali.
  -- Nessun vincolo strutturale viene rilassato dalle foto.
  -- ═══════════════════════════════════════════════════════════════════
  CREATE TEMP TABLE _img_members ON COMMIT DROP AS
  SELECT g.czone_slug, g.via_n, g.locali, g.identity_key, g.sub_idx, g.bagni_key,
         g.czone_slug || '|' || g.via_n || '|' || g.locali::text || '|' ||
           g.identity_key || '|' || g.sub_idx::text || '|' || g.bagni_key AS gkey,
         g.id, g.url, g.fonte, g.agency_key, g.agency_raw, g.mq, g.bagni, g.prezzo,
         g.lat, g.lng, g.quartiere, g.civico_n, g.l_last_seen_at,
         c.canonical_listing_id,
         COALESCE(l.ev_piano_key, public.padova_unit_floor_key_v2(l.raw_json)) AS piano_k,
         public.padova_unit_tipologia(l.raw_json) AS tipologia,
         public.padova_listing_has_auction_evidence(l.raw_json, g.agency_raw) AS is_asta,
         public.padova_listing_has_mls_exclusive_evidence(l.raw_json) AS is_mls
    FROM _grp2 g
    JOIN _cand c ON c.id = g.id
    JOIN public.padova_listings l ON l.id = g.id
   WHERE coalesce(g.agency_key,'') <> ''
     AND EXISTS (
       SELECT 1 FROM public.civiko_listing_photo_pair_evidence e
        WHERE e.listing_a = g.id OR e.listing_b = g.id);

  CREATE TEMP TABLE _img_pairs ON COMMIT DROP AS
  SELECT x.gkey,
         count(*) AS n_pairs,
         count(*) FILTER (WHERE coalesce(e.shared_photos, 0) >= 2) AS n_pairs_ok,
         sum(coalesce(e.shared_photos, 0)) AS foto_condivise
    FROM _img_members x
    JOIN _img_members y ON y.gkey = x.gkey AND x.id < y.id
     AND x.agency_key <> y.agency_key
    LEFT JOIN public.civiko_listing_photo_pair_evidence e
      ON e.listing_a = x.id AND e.listing_b = y.id
     AND e.evidence_kind = 'IMAGE_PHASH_V1'
   GROUP BY 1;

  CREATE TEMP TABLE _img_grp ON COMMIT DROP AS
  SELECT m.gkey, m.czone_slug, m.via_n, m.locali,
         'IMG:' || m.gkey AS chiave_match,
         count(*) AS n_rows,
         count(DISTINCT m.canonical_listing_id) AS n_annunci_canonici,
         count(DISTINCT m.agency_key) AS n_agenzie,
         count(DISTINCT m.fonte) AS n_portali,
         min(m.mq) AS mq_min, max(m.mq) AS mq_max,
         min(m.prezzo) AS prezzo_min, max(m.prezzo) AS prezzo_max,
         count(DISTINCT m.bagni) FILTER (WHERE m.bagni IS NOT NULL) AS n_bagni,
         count(DISTINCT m.piano_k) FILTER (WHERE m.piano_k IS NOT NULL) AS n_piani,
         count(DISTINCT NULLIF(m.civico_n,'')) AS n_civici,
         count(DISTINCT m.tipologia) FILTER (WHERE m.tipologia IS NOT NULL) AS n_tipologie,
         bool_or(m.is_asta) AS has_asta,
         bool_or(m.is_mls) AS has_mls,
         round(avg(m.mq))::int AS mq_avg,
         (array_agg(m.bagni) FILTER (WHERE m.bagni IS NOT NULL))[1] AS bagni_pick,
         array_agg(DISTINCT m.agency_raw ORDER BY m.agency_raw) AS agenzie,
         array_agg(DISTINCT m.fonte ORDER BY m.fonte) AS fonti,
         array_agg(m.url) AS urls,
         (array_agg(m.quartiere) FILTER (WHERE m.quartiere IS NOT NULL))[1] AS quartiere,
         avg(m.lat) FILTER (WHERE m.lat IS NOT NULL) AS lat,
         avg(m.lng) FILTER (WHERE m.lng IS NOT NULL) AS lng,
         max(m.l_last_seen_at) AS last_seen_at,
         (array_agg(m.piano_k) FILTER (WHERE m.piano_k IS NOT NULL))[1] AS piano_pick
    FROM _img_members m
   GROUP BY 1,2,3,4;

  SELECT count(*) INTO v_img_groups_examined FROM _img_grp;

  CREATE TEMP TABLE _img_ok ON COMMIT DROP AS
  SELECT g.*, p.n_pairs, p.n_pairs_ok, p.foto_condivise
    FROM _img_grp g
    JOIN _img_pairs p ON p.gkey = g.gkey
   WHERE g.n_agenzie >= 2
     AND g.n_annunci_canonici >= 2
     AND g.n_rows BETWEEN 2 AND 4
     AND g.mq_min > 0
     AND g.mq_max::numeric <= greatest(g.mq_min::numeric + 5, g.mq_min::numeric * 1.05)
     AND g.prezzo_min > 0
     AND g.prezzo_max::numeric <= g.prezzo_min::numeric * 1.35
     AND g.n_bagni <= 1
     AND g.n_piani <= 1
     AND g.n_civici <= 1
     AND g.n_tipologie <= 1
     AND g.has_asta IS NOT TRUE
     AND g.has_mls IS NOT TRUE
     AND NOT EXISTS (SELECT 1 FROM _asta_urls a WHERE a.url = ANY(g.urls))
     AND p.n_pairs >= 1
     AND p.n_pairs_ok = p.n_pairs
     AND NOT EXISTS (SELECT 1 FROM _cert c WHERE c.urls && g.urls);

  -- esclusivita' degli annunci anche fra gruppi fotografici
  CREATE TEMP TABLE _img_cert (LIKE _img_ok) ON COMMIT DROP;
  CREATE TEMP TABLE _img_cert_urls (url text PRIMARY KEY) ON COMMIT DROP;

  FOR r IN
    SELECT * FROM _img_ok
     ORDER BY n_agenzie DESC, foto_condivise DESC, n_rows DESC, chiave_match
  LOOP
    IF NOT EXISTS (SELECT 1 FROM _img_cert_urls cu WHERE cu.url = ANY(r.urls)) THEN
      INSERT INTO _img_cert SELECT * FROM _img_ok u WHERE u.gkey = r.gkey;
      INSERT INTO _img_cert_urls SELECT DISTINCT unnest(r.urls) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_img_cert FROM _img_cert;

  -- ═══════════════════════════════════════════════════════════════════
  -- C) QA SULLO STAGING — nessuna scrittura se un controllo fallisce
  -- ═══════════════════════════════════════════════════════════════════$q$],
    [$q$  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA staging contendibili fallita: % gruppi non certificabili', v_bad;
  END IF;$q$, $q$  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA staging contendibili fallita: % gruppi non certificabili', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM _img_cert
   WHERE n_agenzie < 2
      OR coalesce(n_annunci_canonici, 0) < 2
      OR coalesce(n_pairs, 0) < 1
      OR n_pairs_ok <> n_pairs
      OR has_asta IS TRUE
      OR has_mls IS TRUE
      OR czone_slug IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA staging fotografica fallita: % gruppi non certificabili', v_bad;
  END IF;$q$],
    [$q$        evidence_ref          = EXCLUDED.evidence_ref,
        match_metrics         = EXCLUDED.match_metrics;

  -- Quarantena diagnostica$q$, $q$        evidence_ref          = EXCLUDED.evidence_ref,
        match_metrics         = EXCLUDED.match_metrics;

  -- Pubblicazione dei gruppi certificati dalla prova fotografica reale.
  INSERT INTO public.padova_contendibili AS pc
    (chiave_match, n_agenzie, agenzie, agencies_normalized, fonti, confidenza,
     prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls,
     n_annunci, portals_seen, agency_count_distinct, agency_count_raw,
     n_portali, last_seen_at, updated_at, commercial_zone_slug,
     match_version, evidence_kind, evidence_ref, match_metrics)
  SELECT f.chiave_match, f.n_agenzie, f.agenzie,
         ARRAY(SELECT DISTINCT public.norm_agency(a)
                 FROM unnest(f.agenzie) AS a
                WHERE a IS NOT NULL AND btrim(a) <> ''),
         f.fonti, 'MEDIA',
         f.prezzo_min, f.prezzo_max, f.mq_avg, f.locali, f.bagni_pick,
         f.quartiere, f.lat, f.lng, f.urls, f.n_rows,
         f.fonti, f.n_agenzie, f.n_rows, f.n_portali,
         f.last_seen_at, now(), f.czone_slug,
         v_img_match_version, 'IMAGE_PHASH_V1', 'phash-dct-8x8-v1',
         jsonb_build_object(
           'via', f.via_n, 'piano', f.piano_pick,
           'mq_min', f.mq_min, 'mq_max', f.mq_max,
           'prezzo_ratio', round(f.prezzo_max::numeric / NULLIF(f.prezzo_min,0), 3),
           'n_annunci_canonici', f.n_annunci_canonici,
           'coppie_cross_agenzia', f.n_pairs,
           'coppie_certificate', f.n_pairs_ok,
           'foto_condivise', f.foto_condivise,
           'prova', 'IMAGE_PHASH_V1',
           'urls', to_jsonb(f.urls))
  FROM _img_cert f
  ON CONFLICT (chiave_match) DO UPDATE
    SET n_agenzie             = EXCLUDED.n_agenzie,
        agenzie               = EXCLUDED.agenzie,
        agencies_normalized   = EXCLUDED.agencies_normalized,
        fonti                 = EXCLUDED.fonti,
        confidenza            = EXCLUDED.confidenza,
        prezzo_min            = EXCLUDED.prezzo_min,
        prezzo_max            = EXCLUDED.prezzo_max,
        mq                    = EXCLUDED.mq,
        locali                = EXCLUDED.locali,
        bagni                 = EXCLUDED.bagni,
        quartiere             = EXCLUDED.quartiere,
        lat                   = EXCLUDED.lat,
        lng                   = EXCLUDED.lng,
        urls                  = EXCLUDED.urls,
        n_annunci             = EXCLUDED.n_annunci,
        portals_seen          = EXCLUDED.portals_seen,
        agency_count_distinct = EXCLUDED.agency_count_distinct,
        agency_count_raw      = EXCLUDED.agency_count_raw,
        n_portali             = EXCLUDED.n_portali,
        last_seen_at          = EXCLUDED.last_seen_at,
        updated_at            = now(),
        commercial_zone_slug  = EXCLUDED.commercial_zone_slug,
        match_version         = EXCLUDED.match_version,
        evidence_kind         = EXCLUDED.evidence_kind,
        evidence_ref          = EXCLUDED.evidence_ref,
        match_metrics         = EXCLUDED.match_metrics;

  -- Quarantena diagnostica$q$],
    [$q$  WHERE NOT EXISTS (
    SELECT 1 FROM _cert c
     WHERE c.urls && f.urls
  );$q$, $q$  WHERE NOT EXISTS (
    SELECT 1 FROM _cert c
     WHERE c.urls && f.urls
  )
    AND NOT EXISTS (
    SELECT 1 FROM _img_cert ic
     WHERE ic.urls && f.urls
  );$q$],
    [$q$  DELETE FROM public.padova_contendibili pc
   WHERE NOT EXISTS (SELECT 1 FROM _cert f WHERE f.chiave_match = pc.chiave_match);$q$, $q$  DELETE FROM public.padova_contendibili pc
   WHERE NOT EXISTS (SELECT 1 FROM _cert f WHERE f.chiave_match = pc.chiave_match)
     AND NOT EXISTS (SELECT 1 FROM _img_cert g WHERE g.chiave_match = pc.chiave_match);$q$],
    [$q$   WHERE match_version IS DISTINCT FROM v_match_version
      OR n_agenzie < 2$q$, $q$   WHERE match_version NOT IN (v_match_version, v_img_match_version)
      OR n_agenzie < 2$q$],
    [$q$  SELECT count(*) INTO v_cont_after FROM public.padova_contendibili;$q$, $q$  SELECT count(*) INTO v_bad
    FROM public.padova_contendibili pc
   WHERE pc.evidence_kind = 'IMAGE_PHASH_V1'
     AND (
       coalesce((pc.match_metrics->>'coppie_cross_agenzia')::int, 0) < 1
       OR coalesce((pc.match_metrics->>'coppie_certificate')::int, -1)
            <> coalesce((pc.match_metrics->>'coppie_cross_agenzia')::int, 0)
       OR coalesce((pc.match_metrics->>'n_annunci_canonici')::int, 0) < 2
     );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA fotografica post-scrittura fallita: % contendibili senza prova per coppia', v_bad;
  END IF;

  SELECT count(*) INTO v_cont_after FROM public.padova_contendibili;$q$],
    [$q$    'certificati', v_cert,$q$, $q$    'certificati', v_cert,
    'image_match_version', v_img_match_version,
    'image_gruppi_esaminati', v_img_groups_examined,
    'image_certificati', v_img_cert,$q$]
  ];
  i int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'recompute_padova_listings_contendibili'
     AND p.pronargs = 0;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'recompute_padova_listings_contendibili assente';
  END IF;

  IF position('canonical-listing-dedup-v1' in v_src) = 0
     OR position('QA identita canonica fallita: % contendibili con meno di 2 annunci canonici distinti' in v_src) = 0 THEN
    RAISE EXCEPTION 'definizione corrente priva di canonical-listing-dedup-v1: stop';
  END IF;

  IF position('image-phash-v1' in v_src) > 0 THEN
    RAISE NOTICE 'image-phash-v1 gia collegato: nessuna patch necessaria';
    RETURN;
  END IF;

  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    v_old := v_pairs[i][1];
    v_new := v_pairs[i][2];
    IF position(v_old in v_src) = 0 THEN
      RAISE EXCEPTION 'ancora % non trovata nella definizione corrente: %', i, left(v_old, 80);
    END IF;
    v_src := overlay(v_src placing v_new from position(v_old in v_src) for length(v_old));
  END LOOP;

  IF position('IMAGE_PHASH_V1' in v_src) = 0
     OR position('civiko_listing_photo_pair_evidence' in v_src) = 0 THEN
    RAISE EXCEPTION 'patch fotografica non applicata';
  END IF;

  EXECUTE v_src;
END
$mig$;
