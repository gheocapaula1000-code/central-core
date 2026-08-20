-- Casa listings store a single raw_json.image URL. The certifier used to
-- read only raw_json.media.images, so Casa never entered the fingerprint
-- pool (142 fresh image URLs, 0 with_media). Backfill ev_image_refs from
-- typical portal photo fields so the existing candidate pool can see them.
--
-- Empty photo publish is not success: the nightly wrapper records
-- identity_starved / empty_photo_publish when pair evidence or public
-- contendibili are zero.
--
-- No new database. No secrets.

-- ── 1) backfill ev_image_refs from raw_json.image (Casa) ──────────────────
UPDATE public.padova_listings p
   SET ev_image_refs = jsonb_build_array(
         jsonb_build_object(
           'url', trim(p.raw_json->>'image'),
           'kind', 'detail',
           'source', 'raw_json.image'
         )
       )
 WHERE p.expired_at IS NULL
   AND p.ev_image_refs IS NULL
   AND p.raw_json ? 'image'
   AND coalesce(trim(p.raw_json->>'image'), '') ~* '^https://'
   AND length(trim(p.raw_json->>'image')) BETWEEN 16 AND 400;

-- ── 2) backfill from raw_json.images / photos / _photos string arrays ────
UPDATE public.padova_listings p
   SET ev_image_refs = (
         SELECT jsonb_agg(
                  jsonb_build_object(
                    'url', trim(elem),
                    'kind', 'detail',
                    'source', 'raw_json.photos'
                  )
                )
           FROM (
             SELECT jsonb_array_elements_text(arr) AS elem
               FROM (
                 SELECT CASE
                          WHEN jsonb_typeof(p.raw_json->'images') = 'array'
                            THEN p.raw_json->'images'
                          WHEN jsonb_typeof(p.raw_json->'photos') = 'array'
                            THEN p.raw_json->'photos'
                          WHEN jsonb_typeof(p.raw_json->'_photos') = 'array'
                            THEN p.raw_json->'_photos'
                          ELSE '[]'::jsonb
                        END AS arr
               ) src
           ) urls
          WHERE trim(elem) ~* '^https://'
            AND length(trim(elem)) BETWEEN 16 AND 400
       )
 WHERE p.expired_at IS NULL
   AND p.ev_image_refs IS NULL
   AND (
        jsonb_typeof(p.raw_json->'images') = 'array'
     OR jsonb_typeof(p.raw_json->'photos') = 'array'
     OR jsonb_typeof(p.raw_json->'_photos') = 'array'
   );

-- ── 3) nightly wrapper: empty photo publish is not success ───────────────
CREATE OR REPLACE FUNCTION public.recompute_padova_contendibili()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_r1 jsonb;
  v_r2 jsonb;
  v_pairs bigint;
  v_after int;
  v_ok boolean;
  v_out jsonb;
  v_err text;
BEGIN
  v_r1 := public.recompute_padova_listings_contendibili();
  v_r2 := public.recompute_padova_contendibili_extras();

  SELECT count(*) INTO v_pairs
    FROM public.civiko_listing_photo_pair_evidence;

  v_after := coalesce((v_r1->>'contendibili_after')::int, 0);
  v_ok := v_after > 0 AND v_pairs > 0;
  v_err := CASE
             WHEN v_pairs = 0 THEN 'identity_starved'
             WHEN v_after = 0 THEN 'empty_photo_publish'
           END;

  v_out := jsonb_build_object(
    'ok', v_ok,
    'identity_starved', v_pairs = 0,
    'photo_pair_evidence', v_pairs,
    'contendibili_after', v_after,
    'match_version', coalesce(v_r1->>'match_version', 'v5-photo-mq-price-zone'),
    'listings', v_r1,
    'extras', v_r2
  );
  IF v_err IS NOT NULL THEN
    v_out := v_out || jsonb_build_object('error', v_err);
  END IF;

  INSERT INTO public.padova_recompute_last_result (id, result, created_at)
  VALUES (1, v_out, clock_timestamp())
  ON CONFLICT (id) DO UPDATE
    SET result = EXCLUDED.result,
        created_at = EXCLUDED.created_at;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.recompute_padova_contendibili() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_padova_contendibili() TO service_role;

COMMENT ON FUNCTION public.recompute_padova_contendibili() IS
  'v5 wrapper: listings + extras. ok=false when photo pair evidence is 0 or publish is empty.';
