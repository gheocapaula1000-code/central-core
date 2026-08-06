-- ═══════════════════════════════════════════════════════════════════════
-- CIVIKO MATCHER P0 REPAIR — contratto di prova esplicito per ogni edge.
-- Additiva/isolata Civiko: nessun provider, nessun recompute reale, nessun
-- cron, nessuna modifica ad altre PWA.
-- ═══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.civiko_padova_matcher_v4_pairs();

CREATE FUNCTION public.civiko_padova_matcher_v4_pairs()
 RETURNS TABLE(a_id bigint, b_id bigint, shared_photos integer, prezzo_ratio numeric,
               dist_m numeric, geo_unita_testo_ok boolean, pair_kind text,
               match_version text, evidence_branch text, photo_strong boolean)
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
     WHERE e.evidence_kind = 'IMAGE_PHASH_V1'
     GROUP BY 1, 2
  ),
  -- REJECT COMUNI A OGNI RAMO: stessa canonical listing, stessa agency
  -- identity, asta/MLS, fuori Comune Padova o fuori allowlist 8 zone
  -- (gia' imposti nei candidati), prezzo oltre il 15%.
  -- NB: stessa property identity / stesso civico fra agenzie DIVERSE e' il
  -- caso d'uso dei contendibili e non e' mai un veto.
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
  -- RAMO PHOTO — nessun requisito globale di piano/tipologia/locali/mq/
  -- bagni/civico/identity_key.
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
         -- <=10%: >=1 foto certificata + almeno UN segnale non fotografico
         -- compatibile (plausibilita'), mai il set completo dei metadati.
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
         -- 10-15%: >=2 foto certificate, nessun requisito di metadata.
         OR (b.prezzo_ratio > 1.10 AND b.prezzo_ratio <= 1.15 AND pe.shared_photos >= 2)
       )
  ),
  -- RAMO STRUCTURAL — mantiene interamente i propri requisiti di metadata.
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
       AND (b.x).locali = (b.y).locali
       AND (b.x).tipologia IS NOT NULL AND (b.y).tipologia IS NOT NULL
       AND (b.x).tipologia = (b.y).tipologia
       AND (b.x).piano_k IS NOT NULL AND (b.y).piano_k IS NOT NULL
       AND (b.x).piano_k = (b.y).piano_k
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

-- ═══════════════════════════════════════════════════════════════════════
-- Patch chirurgica e tracciabile del solo blocco gruppo/QA dentro
-- recompute_padova_listings_contendibili(): ancore verificate, fail-closed
-- se il sorgente live non corrisponde (nessuna riscrittura alla cieca).
-- ═══════════════════════════════════════════════════════════════════════
DO $do$
DECLARE
  v_src   text;
  v_pre   text;
  v_post  text;
  v_anchor_a constant text := '  CREATE TEMP TABLE _pe ON COMMIT DROP AS';
  v_anchor_b constant text := '  IF v_bad > 0 THEN
    RAISE EXCEPTION ''QA staging coppie v4 fallita: % gruppi non certificabili'', v_bad;
  END IF;';
  v_metrics_old constant text := '           ''coppie_geo_unita_testo'', f.n_pairs_geo,
           ''foto_condivise'', f.foto_condivise,';
  v_metrics_new constant text := '           ''coppie_geo_unita_testo'', f.n_pairs_geo,
           ''coppie_foto'', f.n_pairs_photo,
           ''coppie_strutturali'', f.n_pairs_struct,
           ''ramo_prova'', CASE WHEN coalesce(f.n_pairs_photo,0) > 0
                              THEN ''PHOTO'' ELSE ''STRUCTURAL'' END,
           ''foto_condivise'', f.foto_condivise,';
  v_block text;
  v_pos_a int;
  v_pos_b int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'recompute_padova_listings_contendibili';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'recompute_padova_listings_contendibili non trovata';
  END IF;

  v_pos_a := position(v_anchor_a in v_src);
  v_pos_b := position(v_anchor_b in v_src);
  IF v_pos_a = 0 OR v_pos_b = 0 OR v_pos_b <= v_pos_a THEN
    RAISE EXCEPTION 'Ancore matcher non trovate nel sorgente live (a=%, b=%)', v_pos_a, v_pos_b;
  END IF;
  IF position(v_metrics_old in v_src) = 0 THEN
    RAISE EXCEPTION 'Ancora match_metrics non trovata nel sorgente live';
  END IF;

  v_pre  := substring(v_src from 1 for v_pos_a - 1);
  v_post := substring(v_src from v_pos_b + length(v_anchor_b));

  v_block := $blk$  CREATE TEMP TABLE _pe ON COMMIT DROP AS
  SELECT p.a_id, p.b_id, p.shared_photos, p.prezzo_ratio, p.dist_m,
         p.geo_unita_testo_ok, p.pair_kind, p.evidence_branch, p.photo_strong
    FROM public.civiko_padova_matcher_v4_pairs() p
   WHERE EXISTS (SELECT 1 FROM _photo_cand x WHERE x.id = p.a_id)
     AND EXISTS (SELECT 1 FROM _photo_cand y WHERE y.id = p.b_id);

  -- Clique COMPLETE (complete-link) 2..4: ogni coppia interna deve esistere
  -- come edge valida del proprio ramo. Vietata la transitivita' A-B + B-C
  -- senza A-C: le join impongono tutte le coppie del gruppo.
  CREATE TEMP TABLE _photo_cliques ON COMMIT DROP AS
  SELECT ARRAY[p.a_id, p.b_id] AS ids, 2 AS n_rows
    FROM _pe p
  UNION ALL
  SELECT ARRAY[p1.a_id, p1.b_id, p2.b_id], 3
    FROM _pe p1
    JOIN _pe p2 ON p2.a_id = p1.a_id AND p2.b_id > p1.b_id
    JOIN _pe p3 ON p3.a_id = p1.b_id AND p3.b_id = p2.b_id
  UNION ALL
  SELECT ARRAY[p1.a_id, p1.b_id, p2.b_id, p3.b_id], 4
    FROM _pe p1
    JOIN _pe p2 ON p2.a_id = p1.a_id AND p2.b_id > p1.b_id
    JOIN _pe p3 ON p3.a_id = p1.a_id AND p3.b_id > p2.b_id
    JOIN _pe p4 ON p4.a_id = p1.b_id AND p4.b_id = p2.b_id
    JOIN _pe p5 ON p5.a_id = p1.b_id AND p5.b_id = p3.b_id
    JOIN _pe p6 ON p6.a_id = p2.b_id AND p6.b_id = p3.b_id;

  -- Ogni edge conserva il PROPRIO ramo di prova fino alla certificazione.
  CREATE TEMP TABLE _clique_edges ON COMMIT DROP AS
  SELECT 'IMG:' || md5(array_to_string(k.ids, ',')) AS gkey,
         e.a_id, e.b_id, e.shared_photos, e.prezzo_ratio, e.dist_m,
         e.geo_unita_testo_ok, e.evidence_branch, e.photo_strong
    FROM _photo_cliques k
    JOIN _pe e ON e.a_id = ANY(k.ids) AND e.b_id = ANY(k.ids);

  CREATE TEMP TABLE _clique_edge_agg ON COMMIT DROP AS
  SELECT ce.gkey,
         count(*)::bigint AS n_pairs,
         coalesce(sum(ce.shared_photos), 0)::bigint AS foto_condivise,
         count(*) FILTER (WHERE ce.geo_unita_testo_ok)::bigint AS n_pairs_geo,
         count(*) FILTER (WHERE ce.evidence_branch = 'PHOTO')::bigint AS n_pairs_photo,
         count(*) FILTER (WHERE ce.evidence_branch = 'STRUCTURAL')::bigint AS n_pairs_struct,
         count(*) FILTER (WHERE ce.prezzo_ratio > 1.15)::bigint AS n_pairs_over15,
         count(*) FILTER (WHERE ce.evidence_branch = 'PHOTO'
                            AND ce.photo_strong IS NOT TRUE)::bigint AS n_pairs_photo_weak
    FROM _clique_edges ce
   GROUP BY ce.gkey;

  CREATE TEMP TABLE _img_grp ON COMMIT DROP AS
  SELECT 'IMG:' || md5(array_to_string(k.ids, ',')) AS gkey,
         'IMG:' || md5(array_to_string(k.ids, ',')) AS chiave_match,
         k.n_rows,
         a.n_pairs, a.n_pairs AS n_pairs_ok, a.foto_condivise,
         a.n_pairs_geo, a.n_pairs_photo, a.n_pairs_struct,
         a.n_pairs_over15, a.n_pairs_photo_weak,
         (k.n_rows * (k.n_rows - 1) / 2)::bigint AS n_pairs_attese,
         bool_or(m.is_asta) AS has_asta,
         bool_or(m.is_mls) AS has_mls,
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
    JOIN _clique_edge_agg a
      ON a.gkey = 'IMG:' || md5(array_to_string(k.ids, ','))
    JOIN _photo_cand m ON m.id = ANY(k.ids)
   GROUP BY k.ids, k.n_rows, a.n_pairs, a.foto_condivise, a.n_pairs_geo,
            a.n_pairs_photo, a.n_pairs_struct, a.n_pairs_over15,
            a.n_pairs_photo_weak;

  SELECT count(*) INTO v_img_groups_examined FROM _img_grp;

  -- GATE DI GRUPPO — contratto esplicito:
  --  * reject comuni (asta/MLS, zona unica ufficiale, canonical distinti,
  --    agenzie distinte, prezzo <= 15%) validi per OGNI ramo;
  --  * complete-link: n_pairs deve coprire tutte le coppie del gruppo;
  --  * i requisiti di metadata (locali/mq/bagni/piano/tipologia) valgono SOLO
  --    per i gruppi interamente strutturali: un gruppo con almeno una prova
  --    fotografica non li subisce (metadati mancanti o divergenti ammessi).
  CREATE TEMP TABLE _img_ok ON COMMIT DROP AS
  SELECT g.*
    FROM _img_grp g
   WHERE g.n_zone = 1
     AND g.has_asta IS NOT TRUE
     AND g.has_mls IS NOT TRUE
     AND g.n_agenzie >= 2
     AND g.n_annunci_canonici >= 2
     AND g.n_annunci_canonici = g.n_rows
     AND g.n_rows BETWEEN 2 AND 4
     AND g.n_pairs = g.n_pairs_attese
     AND g.n_pairs_over15 = 0
     AND g.n_pairs_photo_weak = 0
     AND g.mq_min > 0
     AND g.prezzo_min > 0
     AND g.prezzo_max::numeric <= g.prezzo_min::numeric * 1.15
     AND (
       g.n_pairs_photo > 0
       OR (
         g.n_locali = 1
         AND g.mq_max::numeric <= greatest(g.mq_min::numeric + 5, g.mq_min::numeric * 1.05)
         AND g.n_bagni <= 1
         AND g.n_piani <= 1
         AND g.n_tipologie <= 1
       )
     );

  CREATE TEMP TABLE _img_cert (LIKE _img_ok) ON COMMIT DROP;
  CREATE TEMP TABLE _img_cert_urls (url text PRIMARY KEY) ON COMMIT DROP;

  FOR r IN
    SELECT * FROM _img_ok
     ORDER BY n_rows DESC, n_agenzie DESC, foto_condivise DESC, n_pairs_geo DESC, chiave_match
  LOOP
    IF NOT EXISTS (SELECT 1 FROM _img_cert_urls cu WHERE cu.url = ANY(r.urls)) THEN
      INSERT INTO _img_cert SELECT * FROM _img_ok u WHERE u.gkey = r.gkey;
      INSERT INTO _img_cert_urls SELECT DISTINCT unnest(r.urls) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_img_cert FROM _img_cert;
  SELECT count(*) INTO v_pair_geo_groups FROM _img_cert WHERE coalesce(foto_condivise,0) = 0;

  -- ═══════════════════════════════════════════════════════════════════
  -- C) QA SULLO STAGING — nessuna scrittura se un controllo fallisce
  -- ═══════════════════════════════════════════════════════════════════
  SELECT count(*) INTO v_bad FROM _cert
   WHERE n_agenzie < 2
      OR coalesce(n_annunci_canonici, 0) < 2
      OR coalesce(civico_n,'') = ''
      OR tipologia IS NULL
      OR locali IS NULL
      OR prezzo_max::numeric > prezzo_min::numeric * 1.10
      OR mq_max::numeric > greatest(mq_min::numeric + 5, mq_min::numeric * 1.05)
      OR n_bagni > 1
      OR n_piani > 1
      OR kind IS NULL
      OR czone_slug IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA staging contendibili fallita: % gruppi non certificabili', v_bad;
  END IF;

  -- QA coppie v4 BRANCH-AWARE: i reject comuni valgono sempre; i vincoli di
  -- metadata sono verificati SOLO sui gruppi interamente strutturali.
  SELECT count(*) INTO v_bad FROM _img_cert
   WHERE n_agenzie < 2
      OR coalesce(n_annunci_canonici, 0) < 2
      OR n_annunci_canonici <> n_rows
      OR coalesce(n_pairs, 0) < 1
      OR n_pairs_ok <> n_pairs
      OR n_pairs <> n_pairs_attese
      OR coalesce(n_pairs_over15, 0) > 0
      OR coalesce(n_pairs_photo_weak, 0) > 0
      OR has_asta IS TRUE
      OR has_mls IS TRUE
      OR n_zone <> 1
      OR czone_slug IS NULL
      OR prezzo_max::numeric > prezzo_min::numeric * 1.15
      OR (coalesce(n_pairs_photo, 0) = 0
          AND (
            n_locali <> 1
            OR n_bagni > 1
            OR n_piani > 1
            OR n_tipologie > 1
            OR mq_max::numeric > greatest(mq_min::numeric + 5, mq_min::numeric * 1.05)
          ))
      OR (coalesce(foto_condivise, 0) = 0
          AND coalesce(n_pairs_photo, 0) = 0
          AND coalesce(n_pairs_geo, 0) = 0
          AND prezzo_max::numeric > prezzo_min::numeric * 1.10);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA staging coppie v4 fallita: % gruppi non certificabili', v_bad;
  END IF;$blk$;

  v_src := v_pre || v_block || v_post;
  v_src := replace(v_src, v_metrics_old, v_metrics_new);

  IF position('n_pairs_photo' in v_src) = 0
     OR position('_clique_edge_agg' in v_src) = 0 THEN
    RAISE EXCEPTION 'Patch matcher non applicata: blocco branch-aware assente';
  END IF;

  EXECUTE v_src;
END
$do$;

-- ═══════════════════════════════════════════════════════════════════════
-- REGRESSION FIXTURE (sola lettura, fail-closed): i negativi noti non
-- devono MAI comparire come coppia; i positivi noti sono verificati e
-- riportati come NOTICE (dipendono dalla presenza delle prove foto).
-- Nessun recompute reale viene eseguito qui.
-- ═══════════════════════════════════════════════════════════════════════
DO $qa$
DECLARE
  v_bad int;
  v_pos int;
BEGIN
  -- Una sola esecuzione del matcher per tutti i controlli (no timeout).
  CREATE TEMP TABLE _qa_pairs ON COMMIT DROP AS
  SELECT * FROM public.civiko_padova_matcher_v4_pairs();

  SELECT count(*) INTO v_bad
    FROM _qa_pairs p
   WHERE (least(p.a_id, p.b_id), greatest(p.a_id, p.b_id))
         IN ((2309, 60498), (3619, 60735));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Regressione matcher: % coppie negative note riammesse', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM _qa_pairs p
   WHERE p.prezzo_ratio > 1.15
      OR (p.evidence_branch = 'PHOTO' AND p.shared_photos < 1)
      OR (p.evidence_branch = 'PHOTO' AND p.prezzo_ratio > 1.10 AND p.shared_photos < 2)
      OR p.evidence_branch IS NULL
      OR p.evidence_branch NOT IN ('PHOTO', 'STRUCTURAL');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Contratto edge violato: % coppie fuori banda o senza ramo', v_bad;
  END IF;

  SELECT count(*) INTO v_pos
    FROM _qa_pairs p
   WHERE (least(p.a_id, p.b_id), greatest(p.a_id, p.b_id))
         IN ((44787, 101390));
  RAISE NOTICE 'Fixture positivi 44787/101390 presenti: %', v_pos;
END
$qa$;