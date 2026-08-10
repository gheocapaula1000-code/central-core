-- 1) Matcher: usa colonne persistite con fallback
CREATE OR REPLACE FUNCTION public.civiko_padova_matcher_v4_candidates()
 RETURNS TABLE(id bigint, url text, fonte text, mq integer, locali integer, bagni integer, prezzo bigint, l_last_seen_at timestamp with time zone, lat double precision, lng double precision, quartiere text, agency_raw text, agency_key text, via_n text, civico_n text, czone_slug text, canonical_listing_id text, piano_k text, tipologia text, descr_fp text, identity_key text, is_asta boolean, is_mls boolean, title_type_ok boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH base AS MATERIALIZED (
    SELECT p.id::bigint AS id, p.url, p.fonte, p.mq::int AS mq, p.locali::int AS locali,
           p.bagni::int AS bagni, p.prezzo::bigint AS prezzo,
           p.last_seen_at AS l_last_seen_at,
           CASE WHEN p.lat BETWEEN 45.30 AND 45.50 THEN p.lat END AS lat,
           CASE WHEN p.lng BETWEEN 11.75 AND 12.00 THEN p.lng END AS lng,
           p.quartiere,
           p.agency AS agency_raw,
           COALESCE(
             p.ev_agency_key,
             NULLIF(public.norm_agency(regexp_replace(lower(trim(p.agency)),
               '^(agenzia immobiliare|immobiliare)\s+', '', 'g')), ''),
             public.norm_agency(p.agency)
           ) AS agency_key,
           COALESCE(p.ev_via_norm, public.padova_via_key(p.indirizzo)) AS via_n,
           COALESCE(p.ev_civico_norm, '') AS civico_n,
           p.commercial_zone_slug AS czone_slug,
           COALESCE(p.ev_canonical_listing_id, public.padova_listing_canonical_id(p.url, p.fonte)) AS canonical_listing_id,
           COALESCE(p.ev_piano_key, public.padova_unit_floor_key_v2(p.raw_json)) AS piano_k,
           COALESCE(p.ev_tipologia, public.padova_unit_tipologia(p.raw_json)) AS tipologia,
           COALESCE(p.ev_descr_fp,
             CASE WHEN length(regexp_replace(lower(COALESCE(p.raw_json->>'description', p.raw_json->>'body','')), '[^a-z0-9]+','','g')) >= 160
                  THEN md5(left(regexp_replace(lower(COALESCE(p.raw_json->>'description', p.raw_json->>'body','')), '[^a-z0-9]+','','g'), 400))
             END) AS descr_fp,
           COALESCE(p.ev_is_asta, public.padova_listing_has_auction_evidence(p.raw_json, p.agency)) AS is_asta,
           COALESCE(p.ev_is_mls, public.padova_listing_has_mls_exclusive_evidence(p.raw_json)) AS is_mls,
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

-- 2) Recompute: sostituzione testuale mirata delle sole espressioni costose
DO $do$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'recompute_padova_listings_contendibili';

  src := replace(src,
    'public.padova_listing_has_auction_evidence(l.raw_json, c.agency_raw)',
    'COALESCE(l.ev_is_asta, public.padova_listing_has_auction_evidence(l.raw_json, c.agency_raw))');
  src := replace(src,
    'public.padova_listing_has_auction_evidence(l.raw_json, g.agency_raw)',
    'COALESCE(l.ev_is_asta, public.padova_listing_has_auction_evidence(l.raw_json, g.agency_raw))');
  src := replace(src,
    'public.padova_listing_has_auction_evidence(l.raw_json, l.agency)',
    'COALESCE(l.ev_is_asta, public.padova_listing_has_auction_evidence(l.raw_json, l.agency))');
  src := replace(src,
    'public.padova_listing_has_mls_exclusive_evidence(l.raw_json)',
    'COALESCE(l.ev_is_mls, public.padova_listing_has_mls_exclusive_evidence(l.raw_json))');
  src := replace(src,
    'public.padova_unit_tipologia(l.raw_json)',
    'COALESCE(l.ev_tipologia, public.padova_unit_tipologia(l.raw_json))');
  src := replace(src,
    'public.norm_agency(p.agency) AS agency_n_full',
    'COALESCE(p.ev_agency_key, public.norm_agency(p.agency)) AS agency_n_full');

  EXECUTE 'CREATE OR REPLACE FUNCTION public.recompute_padova_listings_contendibili() '
       || 'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS '
       || '$civiko_rc_20260810$' || src || '$civiko_rc_20260810$';
END $do$;