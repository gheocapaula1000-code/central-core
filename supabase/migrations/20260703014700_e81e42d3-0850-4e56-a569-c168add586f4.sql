
-- 1) Tabella dedicata cambi agenzia (lead autonomi, non impattano contendibili)
CREATE TABLE IF NOT EXISTS public.padova_cambi_agenzia (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canon_url             text NOT NULL,
  portale               text,
  agenzia_precedente    text NOT NULL,
  agenzia_nuova         text NOT NULL,
  data_cambio           timestamptz NOT NULL,
  titolo                text,
  indirizzo             text,
  quartiere             text,
  zona_omi              text,
  prezzo_eur            numeric,
  mq                    numeric,
  locali                int,
  first_detected_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  is_active             boolean NOT NULL DEFAULT true,
  contendibile_overlap  boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT padova_cambi_agenzia_uniq UNIQUE (canon_url, data_cambio)
);

CREATE INDEX IF NOT EXISTS padova_cambi_agenzia_data_idx     ON public.padova_cambi_agenzia (data_cambio DESC);
CREATE INDEX IF NOT EXISTS padova_cambi_agenzia_quartiere_idx ON public.padova_cambi_agenzia (quartiere, data_cambio DESC);
CREATE INDEX IF NOT EXISTS padova_cambi_agenzia_omi_idx      ON public.padova_cambi_agenzia (zona_omi, data_cambio DESC);

GRANT SELECT ON public.padova_cambi_agenzia TO authenticated;
GRANT ALL    ON public.padova_cambi_agenzia TO service_role;

ALTER TABLE public.padova_cambi_agenzia ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.padova_cambi_agenzia;
CREATE POLICY "service_role full access" ON public.padova_cambi_agenzia
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.padova_cambi_agenzia_touch_updated()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_padova_cambi_agenzia_updated ON public.padova_cambi_agenzia;
CREATE TRIGGER trg_padova_cambi_agenzia_updated
  BEFORE UPDATE ON public.padova_cambi_agenzia
  FOR EACH ROW EXECUTE FUNCTION public.padova_cambi_agenzia_touch_updated();

-- 2) Estende detect_padova_cambio_agenzia(): scrive TUTTI i cambi in padova_cambi_agenzia
--    e mantiene inalterata la marcatura opzionale su padova_contendibili.
CREATE OR REPLACE FUNCTION public.detect_padova_cambio_agenzia()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_urls_scan     int;
  v_urls_cambio   int;
  v_marcati       int;
  v_cambi_scritti int;
BEGIN
  CREATE TEMP TABLE _placeholders(norm text) ON COMMIT DROP;
  INSERT INTO _placeholders(norm) VALUES
    ('disponibile non'),('non specificato'),('non'),('specificato'),
    ('privato'),('private'),('r');

  CREATE TEMP TABLE _snap ON COMMIT DROP AS
  SELECT
    public.canon_url(url)                AS curl,
    source                               AS portale,
    captured_at,
    agency_name                          AS raw_name,
    public.norm_agency_name(agency_name) AS norm_name,
    regexp_split_to_array(public.norm_agency_name(agency_name), '\s+') AS tokens
  FROM public.listing_price_snapshots
  WHERE municipality ILIKE 'padova'
    AND captured_at > now() - interval '90 days'
    AND url IS NOT NULL
    AND agency_name IS NOT NULL
    AND btrim(agency_name) <> '';

  DELETE FROM _snap
   WHERE norm_name IS NULL OR norm_name = ''
      OR norm_name IN (SELECT norm FROM _placeholders);

  CREATE TEMP TABLE _changes ON COMMIT DROP AS
  WITH pairs AS (
    SELECT
      a.curl,
      a.captured_at AS t_prev,
      b.captured_at AS t_new,
      a.raw_name    AS name_prev,
      b.raw_name    AS name_new,
      b.portale     AS portale,
      ROW_NUMBER() OVER (
        PARTITION BY a.curl
        ORDER BY b.captured_at DESC, a.captured_at DESC
      ) AS rn
    FROM _snap a
    JOIN _snap b
      ON a.curl = b.curl
     AND b.captured_at > a.captured_at
     AND (b.captured_at - a.captured_at) >= interval '1 day'
     AND a.norm_name <> b.norm_name
     AND NOT (a.tokens <@ b.tokens)
     AND NOT (b.tokens <@ a.tokens)
  )
  SELECT curl, t_prev, t_new, name_prev, name_new, portale
  FROM pairs
  WHERE rn = 1;

  SELECT COUNT(DISTINCT curl) INTO v_urls_scan   FROM _snap;
  SELECT COUNT(*)             INTO v_urls_cambio FROM _changes;

  -- 2a) Reset marcatura sui contendibili (idempotente, comportamento invariato)
  UPDATE public.padova_contendibili
     SET cambio_agenzia = false,
         cambio_agenzia_data = NULL,
         cambio_agenzia_da   = NULL,
         cambio_agenzia_a    = NULL
   WHERE cambio_agenzia = true OR cambio_agenzia_data IS NOT NULL;

  WITH cand AS (
    SELECT c.id AS cid, ch.t_new, ch.name_prev, ch.name_new,
           ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY ch.t_new DESC) AS rn
    FROM public.padova_contendibili c
    JOIN _changes ch
      ON ch.curl = ANY (SELECT public.canon_url(u) FROM unnest(c.urls) u)
  )
  UPDATE public.padova_contendibili c
     SET cambio_agenzia      = true,
         cambio_agenzia_data = cand.t_new,
         cambio_agenzia_da   = cand.name_prev,
         cambio_agenzia_a    = cand.name_new
    FROM cand
   WHERE c.id = cand.cid AND cand.rn = 1;

  GET DIAGNOSTICS v_marcati = ROW_COUNT;

  -- 2b) URL con overlap contendibili (per flag informativo)
  CREATE TEMP TABLE _overlap ON COMMIT DROP AS
  SELECT DISTINCT public.canon_url(u) AS curl
  FROM public.padova_contendibili c, unnest(c.urls) u;

  -- 2c) Snapshot immobile dal collect v2 (l'item più recente per canon_url)
  CREATE TEMP TABLE _snapshot ON COMMIT DROP AS
  SELECT DISTINCT ON (public.canon_url(url))
    public.canon_url(url) AS curl,
    tipologia, raw_address, quartiere, omi_zone, prezzo, mq, locali
  FROM public.padova_collect_v2_items
  WHERE url IS NOT NULL
  ORDER BY public.canon_url(url), updated_at DESC NULLS LAST, created_at DESC;

  -- 2d) Upsert lead: uno per (canon_url, data_cambio più recente)
  WITH ins AS (
    INSERT INTO public.padova_cambi_agenzia AS pca (
      canon_url, portale, agenzia_precedente, agenzia_nuova, data_cambio,
      titolo, indirizzo, quartiere, zona_omi, prezzo_eur, mq, locali,
      contendibile_overlap
    )
    SELECT
      ch.curl, ch.portale, ch.name_prev, ch.name_new, ch.t_new,
      s.tipologia, s.raw_address, s.quartiere, s.omi_zone,
      s.prezzo, s.mq, s.locali,
      (o.curl IS NOT NULL)
    FROM _changes ch
    LEFT JOIN _snapshot s ON s.curl = ch.curl
    LEFT JOIN _overlap  o ON o.curl = ch.curl
    ON CONFLICT (canon_url, data_cambio) DO UPDATE
      SET last_seen_at         = now(),
          portale              = COALESCE(EXCLUDED.portale, pca.portale),
          agenzia_precedente   = EXCLUDED.agenzia_precedente,
          agenzia_nuova        = EXCLUDED.agenzia_nuova,
          titolo               = COALESCE(EXCLUDED.titolo, pca.titolo),
          indirizzo            = COALESCE(EXCLUDED.indirizzo, pca.indirizzo),
          quartiere            = COALESCE(EXCLUDED.quartiere, pca.quartiere),
          zona_omi             = COALESCE(EXCLUDED.zona_omi, pca.zona_omi),
          prezzo_eur           = COALESCE(EXCLUDED.prezzo_eur, pca.prezzo_eur),
          mq                   = COALESCE(EXCLUDED.mq, pca.mq),
          locali               = COALESCE(EXCLUDED.locali, pca.locali),
          contendibile_overlap = EXCLUDED.contendibile_overlap,
          is_active            = true
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_cambi_scritti FROM ins;

  RETURN jsonb_build_object(
    'ok', true,
    'urls_scannati', v_urls_scan,
    'urls_con_cambio', v_urls_cambio,
    'cambi_scritti', v_cambi_scritti,
    'contendibili_marcati', v_marcati
  );
END;
$function$;
