-- ============================================================================
-- CIVIKO ONE / PADOVA — MATCHER v4: photo_edges vs structural_edges (P0 fix)
-- 1) La stessa identita' immobiliare tra agenzie diverse NON e' un veto:
--    e' precisamente il contendibile. Vietati solo stessa agency_key e
--    stessa canonical (ripubblicazione).
-- 2) Il ramo foto non impone piano/tipologia/locali/mq/bagni.
-- 3) Rami separati, poi UNION: nessun WHERE comune restrittivo.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.civiko_padova_matcher_v4_pairs()
RETURNS TABLE (
  a_id bigint, b_id bigint, shared_photos int, prezzo_ratio numeric,
  dist_m numeric, geo_unita_testo_ok boolean, pair_kind text, match_version text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn_pairs$
  WITH c AS (
    SELECT * FROM public.civiko_padova_matcher_v4_candidates()
  ),
  -- Evidenze fotografiche aggregate per coppia (nessun prerequisito globale).
  photo_ev AS (
    SELECT LEAST(e.listing_a, e.listing_b)::bigint AS a,
           GREATEST(e.listing_a, e.listing_b)::bigint AS b,
           max(coalesce(e.shared_photos, 0))::int AS shared_photos
      FROM public.civiko_listing_photo_pair_evidence e
     WHERE e.evidence_kind = 'IMAGE_PHASH_V1'
     GROUP BY 1, 2
  ),
  -- Base comune SOLO per i vincoli non negoziabili: stessa zona ufficiale,
  -- agenzie distinte, canonical distinti. Asta/MLS gia' esclusi a monte.
  -- NB: stesso indirizzo/civico fra agenzie diverse non e' mai un veto.
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
  ),
  -- RAMO A — coppie da evidenza fotografica (nessun requisito di unita').
  photo_edges AS (
    SELECT b.a_id, b.b_id, pe.shared_photos, b.prezzo_ratio, b.dist_m,
           false AS geo_unita_testo_ok,
           CASE WHEN pe.shared_photos >= 2 AND b.prezzo_ratio > 1.10
                THEN 'FOTO_PHASH_2' ELSE 'FOTO_PHASH_1' END AS pair_kind
      FROM base b
      JOIN photo_ev pe ON pe.a = b.a_id AND pe.b = b.b_id
     WHERE b.prezzo_ratio IS NOT NULL
       AND (
         -- <=10%: almeno 1 pHash + segnali plausibili
         (b.prezzo_ratio <= 1.10
          AND pe.shared_photos >= 1
          AND (
            (b.x).locali = (b.y).locali
            OR greatest((b.x).mq, (b.y).mq)::numeric
                 / NULLIF(least((b.x).mq, (b.y).mq), 0)::numeric <= 1.15
          ))
         -- 10-15%: >=2 pHash condivisi sono prova forte
         OR (b.prezzo_ratio > 1.10 AND b.prezzo_ratio <= 1.15 AND pe.shared_photos >= 2)
       )
  ),
  -- RAMO B — coppie strutturali, senza alcuna foto.
  structural_edges AS (
    SELECT b.a_id, b.b_id, 0::int AS shared_photos, b.prezzo_ratio, b.dist_m,
           (
             b.dist_m IS NOT NULL AND b.dist_m <= 30
             AND (b.x).descr_fp IS NOT NULL AND (b.y).descr_fp IS NOT NULL
             AND (b.x).descr_fp = (b.y).descr_fp
           ) AS geo_unita_testo_ok,
           CASE WHEN b.prezzo_ratio <= 1.10 THEN 'STRUTTURALE_10'
                ELSE 'GEO_UNITA_TESTO' END AS pair_kind
      FROM base b
     WHERE b.prezzo_ratio IS NOT NULL
       AND b.prezzo_ratio <= 1.15
       -- unita' compatibile: requisito del solo ramo strutturale
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
           (array_agg(u.pair_kind ORDER BY u.shared_photos DESC, u.pair_kind))[1] AS pair_kind
      FROM unioned u
     GROUP BY u.a_id, u.b_id
  )
  SELECT m.a_id, m.b_id, m.shared_photos::int, round(m.prezzo_ratio, 4) AS prezzo_ratio,
         m.dist_m, m.geo_unita_testo_ok, m.pair_kind, 'v4'::text AS match_version
    FROM merged m
   WHERE m.prezzo_ratio <= 1.15;
$fn_pairs$;

GRANT EXECUTE ON FUNCTION public.civiko_padova_matcher_v4_pairs() TO service_role;

-- QA statica + fixture reali: fallimento => rollback dell'intera migration ---
DO $qa$
DECLARE
  v_def text;
  v_photo text;
  v_neg int;
  v_over int;
  v_same int;
BEGIN
  v_def := pg_get_functiondef('public.civiko_padova_matcher_v4_pairs()'::regprocedure);

  IF v_def !~ 'photo_edges AS' OR v_def !~ 'structural_edges AS' THEN
    RAISE EXCEPTION 'QA statica: rami photo_edges/structural_edges non separati';
  END IF;
  IF v_def ~ 'x\.identity_key' OR v_def ~ 'identity_key <>' THEN
    RAISE EXCEPTION 'QA statica: identity_key non deve essere un veto';
  END IF;

  v_photo := substring(v_def from 'photo_edges AS.*?structural_edges AS');
  IF v_photo ~ 'piano_k' OR v_photo ~ 'tipologia' THEN
    RAISE EXCEPTION 'QA statica: il ramo foto non puo imporre piano/tipologia';
  END IF;
  IF v_photo ~ 'bagni' THEN
    RAISE EXCEPTION 'QA statica: il ramo foto non puo imporre bagni uguali';
  END IF;

  CREATE TEMP TABLE _qa_pairs ON COMMIT DROP AS
    SELECT * FROM public.civiko_padova_matcher_v4_pairs();

  SELECT count(*) INTO v_neg FROM _qa_pairs
   WHERE (a_id, b_id) IN ((2309, 60498), (60498, 2309), (3619, 60735), (60735, 3619));
  IF v_neg <> 0 THEN
    RAISE EXCEPTION 'QA fixture: prove negative rientrate nel matcher (coppie = %)', v_neg;
  END IF;

  SELECT count(*) INTO v_over FROM _qa_pairs WHERE prezzo_ratio > 1.15;
  IF v_over <> 0 THEN
    RAISE EXCEPTION 'QA: coppie oltre il 15%% presenti (%)', v_over;
  END IF;

  SELECT count(*) INTO v_same
    FROM _qa_pairs p
    JOIN public.civiko_padova_matcher_v4_candidates() x ON x.id = p.a_id
    JOIN public.civiko_padova_matcher_v4_candidates() y ON y.id = p.b_id
   WHERE x.agency_key = y.agency_key
      OR x.canonical_listing_id = y.canonical_listing_id;
  IF v_same <> 0 THEN
    RAISE EXCEPTION 'QA: coppie con stessa agenzia o stessa canonical (%)', v_same;
  END IF;

  RAISE NOTICE 'QA matcher v4 photo/structural superata';
END
$qa$;