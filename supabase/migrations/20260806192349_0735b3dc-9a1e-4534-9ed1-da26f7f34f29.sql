-- CIVIKO ONLY — forward repair matcher v4 (E10/E11/E12/E14)
-- Nessun recompute reale, nessun provider, nessun cron.

DROP FUNCTION IF EXISTS public.civiko_padova_matcher_v4_pairs();
DROP FUNCTION IF EXISTS public.civiko_padova_matcher_v4_candidates();

CREATE FUNCTION public.civiko_padova_matcher_v4_candidates()
RETURNS TABLE(
  id bigint, url text, fonte text, mq integer, locali integer, bagni integer,
  prezzo bigint, l_last_seen_at timestamptz, lat double precision, lng double precision,
  quartiere text, agency_raw text, agency_key text, via_n text, civico_n text,
  czone_slug text, canonical_listing_id text, piano_k text, tipologia text,
  descr_fp text, identity_key text, is_asta boolean, is_mls boolean,
  title_type_ok boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  -- BASE MINIMA (valida per il ramo PHOTO): attivo, Comune Padova esatto,
  -- commercial_zone_slug PERSISTITO nell'allowlist letterale delle 8 zone
  -- ufficiali, url + canonical distinta, agenzia normalizzata nota, prezzo > 0,
  -- nessuna asta/MLS. NESSUN requisito globale di mq, locali, tipologia,
  -- piano, bagni, via, civico o keyword di titolo: quei vincoli vivono
  -- esclusivamente nei rami strutturale/plausibilita'.
  WITH base AS (
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
       AND p.commercial_zone_slug IN (
         'centro-storico','est-brenta','est-forcellini-camin','nord-arcella',
         'ovest-chiesanuova-brentelle','sud-est-sant-osvaldo','sud-ovest-mandria',
         'sud-voltabarozzo-guizza')
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

REVOKE ALL ON FUNCTION public.civiko_padova_matcher_v4_candidates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.civiko_padova_matcher_v4_candidates() TO service_role;

CREATE FUNCTION public.civiko_padova_matcher_v4_pairs()
RETURNS TABLE(
  a_id bigint, b_id bigint, shared_photos integer, prezzo_ratio numeric,
  dist_m numeric, geo_unita_testo_ok boolean, pair_kind text, match_version text,
  evidence_branch text, photo_strong boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH c AS (
    SELECT * FROM public.civiko_padova_matcher_v4_candidates()
  ),
  photo_ev AS (
    SELECT LEAST(e.listing_a, e.listing_b)::bigint AS a,
           GREATEST(e.listing_a, e.listing_b)::bigint AS b,
           max(coalesce(e.shared_photos, 0))::int AS shared_photos
      FROM public.civiko_listing_photo_pair_evidence e
      JOIN public.civiko_photo_evidence_contract() k
        ON e.evidence_kind = k.evidence_kind
       AND e.match_version = k.match_version
       AND e.algo = k.algo
     GROUP BY 1, 2
  ),
  base AS (
    SELECT x.id AS a_id, y.id AS b_id, x, y,
           (greatest(x.prezzo, y.prezzo)::numeric
              / NULLIF(least(x.prezzo, y.prezzo), 0)::numeric) AS prezzo_ratio,
           CASE WHEN x.lat IS NOT NULL AND x.lng IS NOT NULL
                     AND y.lat IS NOT NULL AND y.lng IS NOT NULL
                THEN public.padova_haversine_m(x.lat, x.lng, y.lat, y.lng)::numeric
           END AS dist_m
      FROM c x
      JOIN c y
        ON y.id > x.id
       AND y.czone_slug = x.czone_slug
       AND y.agency_key <> x.agency_key
       AND y.canonical_listing_id <> x.canonical_listing_id
       AND x.is_asta IS NOT TRUE AND y.is_asta IS NOT TRUE
       AND x.is_mls IS NOT TRUE AND y.is_mls IS NOT TRUE
  ),
  photo_edges AS (
    SELECT b.a_id, b.b_id, pe.shared_photos, b.prezzo_ratio, b.dist_m,
           false AS geo_unita_testo_ok,
           CASE WHEN pe.shared_photos >= 2 AND b.prezzo_ratio > 1.10
                THEN 'FOTO_PHASH_2' ELSE 'FOTO_PHASH_1' END AS pair_kind,
           'PHOTO'::text AS evidence_branch,
           true AS photo_strong
      FROM base b
      JOIN photo_ev pe ON pe.a = b.a_id AND pe.b = b.b_id
     WHERE b.prezzo_ratio IS NOT NULL
       AND (
         (b.prezzo_ratio <= 1.10
          AND pe.shared_photos >= 1
          AND (
            (b.x).locali = (b.y).locali
            OR greatest((b.x).mq, (b.y).mq)::numeric
                 / NULLIF(least((b.x).mq, (b.y).mq), 0)::numeric <= 1.15
            OR (b.dist_m IS NOT NULL AND b.dist_m <= 150)
            OR ((b.x).via_n IS NOT NULL AND (b.x).via_n = (b.y).via_n)
            OR (coalesce((b.x).civico_n,'') <> ''
                AND (b.x).civico_n = (b.y).civico_n)
            OR ((b.x).descr_fp IS NOT NULL AND (b.x).descr_fp = (b.y).descr_fp)
            OR ((b.x).tipologia IS NOT NULL AND (b.x).tipologia = (b.y).tipologia)
          ))
         OR (b.prezzo_ratio > 1.10 AND b.prezzo_ratio <= 1.15 AND pe.shared_photos >= 2)
       )
  ),
  -- RAMO STRUCTURAL — porta interamente i vincoli di metadata che NON sono
  -- piu' globali: keyword tipologia nel titolo, locali, mq positivi/compatibili,
  -- piano, tipologia, bagni.
  structural_edges AS (
    SELECT b.a_id, b.b_id, 0::int AS shared_photos, b.prezzo_ratio, b.dist_m,
           (
             b.dist_m IS NOT NULL AND b.dist_m <= 30
             AND (b.x).descr_fp IS NOT NULL AND (b.y).descr_fp IS NOT NULL
             AND (b.x).descr_fp = (b.y).descr_fp
           ) AS geo_unita_testo_ok,
           CASE WHEN b.prezzo_ratio <= 1.10 THEN 'STRUTTURALE_10'
                ELSE 'GEO_UNITA_TESTO' END AS pair_kind,
           'STRUCTURAL'::text AS evidence_branch,
           false AS photo_strong
      FROM base b
     WHERE b.prezzo_ratio IS NOT NULL
       AND b.prezzo_ratio <= 1.15
       AND (b.x).title_type_ok IS TRUE AND (b.y).title_type_ok IS TRUE
       AND (b.x).locali IS NOT NULL AND (b.y).locali IS NOT NULL
       AND (b.x).locali = (b.y).locali
       AND (b.x).mq IS NOT NULL AND (b.y).mq IS NOT NULL
       AND (b.x).tipologia IS NOT NULL AND (b.y).tipologia IS NOT NULL
       AND (b.x).tipologia = (b.y).tipologia
       AND (b.x).piano_k IS NOT NULL AND (b.y).piano_k IS NOT NULL
       AND (b.x).piano_k = (b.y).piano_k
       AND least((b.x).mq, (b.y).mq) > 0
       AND greatest((b.x).mq, (b.y).mq)::numeric
             <= greatest(least((b.x).mq, (b.y).mq)::numeric + 5,
                         least((b.x).mq, (b.y).mq)::numeric * 1.05)
       AND ((b.x).bagni IS NULL OR (b.y).bagni IS NULL OR (b.x).bagni = (b.y).bagni)
       AND (
         b.prezzo_ratio <= 1.10
         OR (
           b.dist_m IS NOT NULL AND b.dist_m <= 30
           AND (b.x).descr_fp IS NOT NULL AND (b.y).descr_fp IS NOT NULL
           AND (b.x).descr_fp = (b.y).descr_fp
         )
       )
  ),
  unioned AS (
    SELECT * FROM photo_edges
    UNION ALL
    SELECT * FROM structural_edges
  ),
  merged AS (
    SELECT u.a_id, u.b_id,
           max(u.shared_photos) AS shared_photos,
           min(u.prezzo_ratio) AS prezzo_ratio,
           min(u.dist_m) AS dist_m,
           bool_or(u.geo_unita_testo_ok) AS geo_unita_testo_ok,
           (array_agg(u.pair_kind ORDER BY u.shared_photos DESC, u.pair_kind))[1] AS pair_kind,
           CASE WHEN bool_or(u.evidence_branch = 'PHOTO') THEN 'PHOTO' ELSE 'STRUCTURAL' END
             AS evidence_branch,
           bool_or(u.photo_strong) AS photo_strong
      FROM unioned u
     GROUP BY u.a_id, u.b_id
  )
  SELECT m.a_id, m.b_id, m.shared_photos::int, round(m.prezzo_ratio, 4) AS prezzo_ratio,
         m.dist_m, m.geo_unita_testo_ok, m.pair_kind, 'v4'::text AS match_version,
         m.evidence_branch,
         (m.evidence_branch = 'PHOTO' AND m.photo_strong) AS photo_strong
    FROM merged m
   WHERE m.prezzo_ratio <= 1.15;
$function$;

REVOKE ALL ON FUNCTION public.civiko_padova_matcher_v4_pairs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.civiko_padova_matcher_v4_pairs() TO service_role;

-- ── PATCH FAIL-CLOSED SULLA DEFINIZIONE INSTALLATA DEL RECOMPUTE ──────────
-- Clique miste: PHOTO solo se OGNI edge richiesta e' fotografica; STRUCTURAL
-- se zero edge fotografiche; altrimenti MIXED_V4. Nessun recompute eseguito.
DO $patch$
DECLARE
  d text; d0 text; o text; n text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
    JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
   WHERE nsp.nspname = 'public'
     AND p.proname = 'recompute_padova_listings_contendibili';
  IF d IS NULL THEN
    RAISE EXCEPTION 'patch: recompute_padova_listings_contendibili non installata';
  END IF;
  d0 := d;

  o := $r1$         CASE WHEN coalesce(f.foto_condivise,0) > 0
              THEN v_img_match_version ELSE v_pair_match_version END,
         CASE WHEN coalesce(f.foto_condivise,0) > 0
              THEN 'IMAGE_PHASH_V1' ELSE 'UNIT_GEO_TEXT_V4' END,
         CASE WHEN coalesce(f.foto_condivise,0) > 0
              THEN 'phash-dct-8x8-v1' ELSE 'geo30m-unit-descrfp-v4' END,$r1$;
  n := $r2$         CASE WHEN coalesce(f.n_pairs_photo,0) > 0
              THEN v_img_match_version ELSE v_pair_match_version END,
         CASE WHEN coalesce(f.n_pairs_photo,0) = 0 THEN 'UNIT_GEO_TEXT_V4'
              WHEN coalesce(f.n_pairs_photo,0) = coalesce(f.n_pairs,0)
                   THEN 'IMAGE_PHASH_V1'
              ELSE 'MIXED_V4' END,
         CASE WHEN coalesce(f.n_pairs_photo,0) = 0 THEN 'geo30m-unit-descrfp-v4'
              WHEN coalesce(f.n_pairs_photo,0) = coalesce(f.n_pairs,0)
                   THEN 'phash-dct-8x8-v1'
              ELSE 'phash-dct-8x8-v1+geo30m-unit-descrfp-v4' END,$r2$;
  IF position(o IN d) = 0 THEN
    RAISE EXCEPTION 'patch: blocco evidence_kind atteso non trovato';
  END IF;
  d := replace(d, o, n);

  o := $r3$           'ramo_prova', CASE WHEN coalesce(f.n_pairs_photo,0) > 0
                              THEN 'PHOTO' ELSE 'STRUCTURAL' END,
           'foto_condivise', f.foto_condivise,
           'match_version', 'v4',
           'prova', CASE WHEN coalesce(f.foto_condivise,0) > 0
                         THEN 'IMAGE_PHASH_V1' ELSE 'UNIT_GEO_TEXT_V4' END,$r3$;
  n := $r4$           'ramo_prova', CASE WHEN coalesce(f.n_pairs_photo,0) = 0
                                   THEN 'STRUCTURAL'
                              WHEN coalesce(f.n_pairs_photo,0) = coalesce(f.n_pairs,0)
                                   THEN 'PHOTO'
                              ELSE 'MIXED_V4' END,
           'coppie_totali', f.n_pairs,
           'foto_condivise', f.foto_condivise,
           'match_version', 'v4',
           'prova', CASE WHEN coalesce(f.n_pairs_photo,0) = 0
                              THEN 'UNIT_GEO_TEXT_V4'
                         WHEN coalesce(f.n_pairs_photo,0) = coalesce(f.n_pairs,0)
                              THEN 'IMAGE_PHASH_V1'
                         ELSE 'MIXED_V4' END,$r4$;
  IF position(o IN d) = 0 THEN
    RAISE EXCEPTION 'patch: blocco match_metrics atteso non trovato';
  END IF;
  d := replace(d, o, n);

  o := $r5$   WHERE pc.evidence_kind IN ('IMAGE_PHASH_V1', 'UNIT_GEO_TEXT_V4')$r5$;
  n := $r6$   WHERE pc.evidence_kind IN ('IMAGE_PHASH_V1', 'UNIT_GEO_TEXT_V4', 'MIXED_V4')$r6$;
  IF position(o IN d) = 0 THEN
    RAISE EXCEPTION 'patch: filtro QA post-scrittura atteso non trovato';
  END IF;
  d := replace(d, o, n);

  IF d = d0 THEN
    RAISE EXCEPTION 'patch: nessuna modifica applicata';
  END IF;

  EXECUTE d;
END
$patch$;

-- ── VERIFICA FAIL-CLOSED SULLA DEFINIZIONE INSTALLATA (read-only) ──────────
DO $verify$
DECLARE
  d_cand text; d_pairs text; d_rec text; v_bad bigint; v_has_ev boolean;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d_cand FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='civiko_padova_matcher_v4_candidates';
  SELECT pg_get_functiondef(p.oid) INTO d_pairs FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='civiko_padova_matcher_v4_pairs';
  SELECT pg_get_functiondef(p.oid) INTO d_rec FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='recompute_padova_listings_contendibili';

  IF d_cand IS NULL OR d_pairs IS NULL OR d_rec IS NULL THEN
    RAISE EXCEPTION 'verifica: definizione mancante';
  END IF;

  IF position('p.mq IS NOT NULL AND p.mq > 0' IN d_cand) > 0
     OR position('AND p.locali IS NOT NULL' IN d_cand) > 0
     OR position('AS title_type_ok' IN d_cand) = 0 THEN
    RAISE EXCEPTION 'verifica: veto globale metadata ancora presente nei candidati';
  END IF;
  IF position('''centro-storico'',''est-brenta''' IN d_cand) = 0
     OR position('p.commercial_zone_slug IN' IN d_cand) = 0
     OR position('p.comune = ''Padova''' IN d_cand) = 0 THEN
    RAISE EXCEPTION 'verifica: perimetro zone/comune non letterale nei candidati';
  END IF;

  IF position('(b.x).title_type_ok IS TRUE AND (b.y).title_type_ok IS TRUE' IN d_pairs) = 0
     OR position('(b.x).locali IS NOT NULL AND (b.y).locali IS NOT NULL' IN d_pairs) = 0
     OR position('(b.x).mq IS NOT NULL AND (b.y).mq IS NOT NULL' IN d_pairs) = 0 THEN
    RAISE EXCEPTION 'verifica: ramo strutturale senza i propri vincoli di metadata';
  END IF;
  IF position('e.match_version = k.match_version' IN d_pairs) = 0
     OR position('e.algo = k.algo' IN d_pairs) = 0 THEN
    RAISE EXCEPTION 'verifica: contratto prove v4 non applicato';
  END IF;

  IF position('MIXED_V4' IN d_rec) = 0 THEN
    RAISE EXCEPTION 'verifica: etichetta MIXED_V4 assente dal recompute';
  END IF;

  SELECT count(*) INTO v_bad FROM public.civiko_padova_matcher_v4_pairs() p
   WHERE (p.a_id, p.b_id) IN ((2309, 60498), (3619, 60735), (60498, 2309), (60735, 3619));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'regressione: coppia negativa nota certificata (% righe)', v_bad;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.civiko_listing_photo_pair_evidence e
      JOIN public.civiko_photo_evidence_contract() k
        ON e.evidence_kind = k.evidence_kind
       AND e.match_version = k.match_version
       AND e.algo = k.algo
     WHERE LEAST(e.listing_a, e.listing_b) = 44787
       AND GREATEST(e.listing_a, e.listing_b) = 101390
       AND coalesce(e.shared_photos, 0) >= 1
  ) INTO v_has_ev;

  IF v_has_ev
     AND EXISTS (SELECT 1 FROM public.civiko_padova_matcher_v4_candidates() c WHERE c.id = 44787)
     AND EXISTS (SELECT 1 FROM public.civiko_padova_matcher_v4_candidates() c WHERE c.id = 101390)
  THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.civiko_padova_matcher_v4_pairs() p
       WHERE LEAST(p.a_id, p.b_id) = 44787 AND GREATEST(p.a_id, p.b_id) = 101390
    ) THEN
      RAISE EXCEPTION 'regressione: coppia positiva 44787/101390 non prodotta con prova v4 esatta';
    END IF;
  ELSE
    RAISE NOTICE 'positivo 44787/101390 non valutabile: prerequisiti v4 esatti assenti';
  END IF;
END
$verify$;