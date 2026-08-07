-- Estensione additiva ISOLATA per il commissioning Civiko One.
-- Non modifica public.promote_padova_collect_v2_to_listings né altre RPC.
-- Riusa fedelmente la sua semantica di upsert, ma limitata a UN job_id,
-- comune Padova, massimo 3 righe (cap micro-run Civiko).

CREATE OR REPLACE FUNCTION public.civiko_commissioning_promote_apify_job(
  p_job_id text,
  p_run_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_max_rows constant int := 3;
  v_new int := 0; v_upd int := 0;
  v_scanned int := 0; v_kept int := 0; v_out int := 0;
  v_out_written int := 0;
  v_urls jsonb := '[]'::jsonb;
  v_now timestamptz := now();
BEGIN
  IF p_job_id IS NULL OR btrim(p_job_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'job_id_required');
  END IF;
  IF p_run_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'run_id_required');
  END IF;

  SELECT count(*) INTO v_scanned
    FROM public.padova_collect_v2_items
   WHERE job_id = p_job_id
     AND url IS NOT NULL
     AND (prezzo IS NOT NULL OR mq IS NOT NULL);

  SELECT count(*) INTO v_kept
    FROM public.padova_collect_v2_items
   WHERE job_id = p_job_id
     AND url IS NOT NULL
     AND (prezzo IS NOT NULL OR mq IS NOT NULL)
     AND public.civiko_is_comune_padova(citta);

  v_out := GREATEST(0, v_scanned - v_kept);

  WITH src AS (
    SELECT * FROM (
      SELECT DISTINCT ON (portal, url)
        portal, url, raw_address, agency, agency_phone,
        prezzo, mq, locali, bagni, lat, lng,
        public.civiko_classify_tipo_lead(tipo_lead, n_agenzie, agency) AS tipo_lead,
        CASE WHEN public.civiko_resolve_commercial_zone_slug(
               regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')) IS NULL
          THEN NULL
          ELSE regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
        END AS quartiere,
        raw_json, updated_at
      FROM public.padova_collect_v2_items
      WHERE job_id = p_job_id
        AND public.civiko_is_comune_padova(citta)
        AND portal IS NOT NULL
        AND url IS NOT NULL
        AND (prezzo IS NOT NULL OR mq IS NOT NULL)
      ORDER BY portal, url, updated_at DESC
    ) d
    ORDER BY d.updated_at DESC, d.url
    LIMIT v_max_rows
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
    RETURNING (xmax = 0) AS inserted,
              public.padova_listings.comune AS comune_out,
              public.padova_listings.url AS url_out
  )
  SELECT count(*) FILTER (WHERE inserted),
         count(*) FILTER (WHERE NOT inserted),
         count(*) FILTER (WHERE NOT public.civiko_is_comune_padova(comune_out)),
         COALESCE(jsonb_agg(url_out ORDER BY url_out), '[]'::jsonb)
    INTO v_new, v_upd, v_out_written, v_urls
    FROM ups;

  -- Audit dedicato Civiko, legato al run del micro-run (best effort:
  -- solo se il run di commissioning esiste già).
  IF EXISTS (SELECT 1 FROM public.civiko_commissioning_runs r WHERE r.run_id = p_run_id) THEN
    INSERT INTO public.civiko_commissioning_artifacts
      (run_id, provider, table_name, change_kind, row_ref, evidence)
    VALUES (
      p_run_id, 'apify', 'padova_listings',
      CASE WHEN v_new > 0 THEN 'insert' ELSE 'update' END,
      p_job_id,
      jsonb_build_object(
        'job_id', p_job_id,
        'promoted_at', v_now,
        'scanned', v_scanned,
        'kept', v_kept,
        'new', v_new,
        'updated', v_upd,
        'out_of_scope_rejected', v_out,
        'out_of_scope_written', v_out_written,
        'max_rows', v_max_rows,
        'urls', v_urls
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', (v_new + v_upd) > 0 AND v_out_written = 0,
    'job_id', p_job_id,
    'run_id', p_run_id,
    'promoted_at', v_now,
    'max_rows', v_max_rows,
    'scanned', v_scanned,
    'kept', v_kept,
    'new', v_new,
    'updated', v_upd,
    'writes', v_new + v_upd,
    'out_of_scope_rejected', v_out,
    'out_of_scope_written', v_out_written,
    'urls', v_urls
  );
END
$function$;

-- ACL fail-closed: solo service_role.
REVOKE ALL ON FUNCTION public.civiko_commissioning_promote_apify_job(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.civiko_commissioning_promote_apify_job(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.civiko_commissioning_promote_apify_job(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_commissioning_promote_apify_job(text, uuid) TO service_role;

COMMENT ON FUNCTION public.civiko_commissioning_promote_apify_job(text, uuid) IS
  'Civiko commissioning only: promuove al massimo 3 righe padova_collect_v2_items del solo job_id indicato (comune Padova) in padova_listings, con audit legato al run di commissioning. Non sostituisce promote_padova_collect_v2_to_listings.';
