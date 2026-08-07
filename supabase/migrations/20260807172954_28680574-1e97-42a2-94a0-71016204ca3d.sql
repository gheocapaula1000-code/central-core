CREATE OR REPLACE FUNCTION public.civiko_padova_matcher_v4_pairs()
RETURNS TABLE(a_id bigint, b_id bigint, shared_photos integer, prezzo_ratio numeric,
              dist_m numeric, geo_unita_testo_ok boolean, pair_kind text,
              match_version text, evidence_branch text, photo_strong boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH c AS MATERIALIZED (
    SELECT * FROM public.civiko_padova_matcher_v4_candidates()
  ),
  photo_ev AS MATERIALIZED (
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
  photo_base AS (
    SELECT x.id AS a_id, y.id AS b_id, x, y, pe.shared_photos,
           (greatest(x.prezzo, y.prezzo)::numeric
             / NULLIF(least(x.prezzo, y.prezzo), 0)::numeric) AS prezzo_ratio,
           CASE WHEN x.lat IS NOT NULL AND x.lng IS NOT NULL
                     AND y.lat IS NOT NULL AND y.lng IS NOT NULL
                THEN public.padova_haversine_m(x.lat, x.lng, y.lat, y.lng)::numeric
           END AS dist_m
      FROM photo_ev pe
      JOIN c x ON x.id = pe.a
      JOIN c y ON y.id = pe.b
       AND y.id > x.id
       AND y.czone_slug = x.czone_slug
       AND y.agency_key <> x.agency_key
       AND y.canonical_listing_id <> x.canonical_listing_id
       AND x.is_asta IS NOT TRUE AND y.is_asta IS NOT TRUE
       AND x.is_mls IS NOT TRUE AND y.is_mls IS NOT TRUE
  ),
  photo_edges AS (
    SELECT b.a_id, b.b_id, b.shared_photos, b.prezzo_ratio, b.dist_m,
           false AS geo_unita_testo_ok,
           CASE WHEN b.shared_photos >= 2 AND b.prezzo_ratio > 1.10
                THEN 'FOTO_PHASH_2' ELSE 'FOTO_PHASH_1' END AS pair_kind,
           'PHOTO'::text AS evidence_branch,
           true AS photo_strong
      FROM photo_base b
     WHERE b.prezzo_ratio IS NOT NULL
       AND (
         (b.prezzo_ratio <= 1.10
          AND b.shared_photos >= 1
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
         OR (b.prezzo_ratio > 1.10 AND b.prezzo_ratio <= 1.15 AND b.shared_photos >= 2)
       )
  ),
  structural_base AS (
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
       AND x.title_type_ok IS TRUE AND y.title_type_ok IS TRUE
       AND x.locali IS NOT NULL AND y.locali IS NOT NULL
       AND x.locali = y.locali
       AND x.mq IS NOT NULL AND y.mq IS NOT NULL
       AND x.tipologia IS NOT NULL AND y.tipologia IS NOT NULL
       AND x.tipologia = y.tipologia
       AND x.piano_k IS NOT NULL AND y.piano_k IS NOT NULL
       AND x.piano_k = y.piano_k
       AND least(x.mq, y.mq) > 0
       AND greatest(x.mq, y.mq)::numeric
             <= greatest(least(x.mq, y.mq)::numeric + 5,
                         least(x.mq, y.mq)::numeric * 1.05)
       AND (x.bagni IS NULL OR y.bagni IS NULL OR x.bagni = y.bagni)
       AND greatest(x.prezzo, y.prezzo)::numeric
             <= least(x.prezzo, y.prezzo)::numeric * 1.15
  ),
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
      FROM structural_base b
     WHERE b.prezzo_ratio IS NOT NULL
       AND b.prezzo_ratio <= 1.15
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

REVOKE ALL ON FUNCTION public.civiko_padova_matcher_v4_pairs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_padova_matcher_v4_pairs() TO service_role;

COMMENT ON FUNCTION public.civiko_padova_matcher_v4_pairs() IS
  'Civiko Padova matcher v4: semantica invariata, rami PHOTO/STRUCTURAL prefiltrati prima della generazione coppie per evitare il prodotto cartesiano per zona.';