CREATE TABLE IF NOT EXISTS public.padova_multi_portale_quarantena (
  id bigserial PRIMARY KEY,
  chiave_match text NOT NULL,
  portals_seen text[],
  portal_count integer,
  agenzie text[],
  prezzo_min integer,
  prezzo_max integer,
  mq integer,
  locali integer,
  bagni integer,
  quartiere text,
  commercial_zone_slug text,
  urls text[],
  n_annunci integer,
  motivi text[] NOT NULL DEFAULT '{}',
  metriche jsonb NOT NULL DEFAULT '{}'::jsonb,
  quarantined_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.padova_multi_portale_quarantena TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.padova_multi_portale_quarantena_id_seq TO service_role;

ALTER TABLE public.padova_multi_portale_quarantena ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mp_quarantena_service_only" ON public.padova_multi_portale_quarantena;
CREATE POLICY "mp_quarantena_service_only"
  ON public.padova_multi_portale_quarantena
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_mp_quarantena_chiave
  ON public.padova_multi_portale_quarantena (chiave_match);

-- ───────────────────────────────────────────────────────────────
-- Gate di certificazione multi-portale.
-- Fail-closed: senza prova forte di unità il gruppo NON resta pubblico.
-- Non tocca padova_contendibili (regole P0 / P0-B invariate).
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.padova_certify_multi_portale()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_before int;
  v_after  int;
  v_quar   int;
BEGIN
  SELECT count(*) INTO v_before FROM public.padova_multi_portale;

  CREATE TEMP TABLE _mp_eval ON COMMIT DROP AS
  SELECT
    m.chiave_match,
    m.portals_seen, m.portal_count, m.agenzie, m.prezzo_min, m.prezzo_max,
    m.mq, m.locali, m.bagni, m.quartiere, m.commercial_zone_slug,
    m.urls, m.n_annunci,
    s.n_rows, s.n_portali, s.n_zone, s.n_agenzie,
    s.n_via, s.d_via,
    s.n_civico, s.d_civico,
    s.n_fp, s.d_fp,
    s.n_piano, s.d_piano,
    s.n_locali, s.n_tipologia, s.d_tipologia,
    s.n_bagni, s.mq_min, s.mq_max, s.pz_min, s.pz_max,
    s.has_asta, s.has_mls
  FROM public.padova_multi_portale m
  CROSS JOIN LATERAL (
    SELECT
      count(*)                                                        AS n_rows,
      count(DISTINCT l.fonte)                                         AS n_portali,
      count(DISTINCT l.commercial_zone_slug)                          AS n_zone,
      count(DISTINCT public.norm_agency(l.agency))
        FILTER (WHERE coalesce(btrim(l.agency),'') <> '' AND l.fonte <> 'subito') AS n_agenzie,
      count(l.ev_via_norm)                                            AS n_via,
      count(DISTINCT l.ev_via_norm)                                   AS d_via,
      count(l.ev_civico_norm)                                         AS n_civico,
      count(DISTINCT l.ev_civico_norm)                                AS d_civico,
      count(l.ev_descr_fp)                                            AS n_fp,
      count(DISTINCT l.ev_descr_fp)                                   AS d_fp,
      count(l.ev_piano_key)                                           AS n_piano,
      count(DISTINCT l.ev_piano_key)                                  AS d_piano,
      count(DISTINCT l.locali)                                        AS n_locali,
      count(public.padova_unit_tipologia(l.raw_json))                 AS n_tipologia,
      count(DISTINCT public.padova_unit_tipologia(l.raw_json))        AS d_tipologia,
      count(DISTINCT l.bagni) FILTER (WHERE l.bagni IS NOT NULL)      AS n_bagni,
      min(l.mq) AS mq_min, max(l.mq) AS mq_max,
      min(l.prezzo) AS pz_min, max(l.prezzo) AS pz_max,
      bool_or(public.padova_listing_has_auction_evidence(l.raw_json, l.agency)) AS has_asta,
      bool_or(
        lower(coalesce(l.raw_json->>'description', l.raw_json->>'body','')) ~
        '(\mmls\M|multiple listing service|incarico in esclusiva|mandato in esclusiva)'
      ) AS has_mls
    FROM public.padova_listings l
    WHERE l.url = ANY(m.urls)
  ) s;

  CREATE TEMP TABLE _mp_verdict ON COMMIT DROP AS
  SELECT e.*,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN e.n_rows < 2 OR e.n_rows > 4                       THEN 'CARDINALITA_NON_VALIDA' END,
      CASE WHEN e.n_portali < 2                                    THEN 'PORTALE_SINGOLO' END,
      CASE WHEN e.n_zone <> 1                                      THEN 'ZONE_DIVERSE' END,
      CASE WHEN e.n_agenzie > 1                                    THEN 'AGENZIE_DIVERSE' END,
      CASE WHEN e.n_via < e.n_rows OR e.d_via <> 1                 THEN 'VIA_ASSENTE_O_DISCORDANTE' END,
      CASE WHEN e.n_locali <> 1                                    THEN 'LOCALI_DISCORDANTI' END,
      CASE WHEN e.n_tipologia < e.n_rows OR e.d_tipologia <> 1     THEN 'TIPOLOGIA_ASSENTE_O_DISCORDANTE' END,
      CASE WHEN e.n_bagni > 1                                      THEN 'BAGNI_DISCORDANTI' END,
      CASE WHEN e.d_piano > 1                                      THEN 'PIANO_DISCORDANTE' END,
      CASE WHEN coalesce(e.mq_min,0) <= 0
             OR e.mq_max::numeric > greatest(e.mq_min::numeric + 5, e.mq_min::numeric * 1.05)
                                                                   THEN 'MQ_INCOMPATIBILI' END,
      CASE WHEN coalesce(e.pz_min,0) <= 0
             OR e.pz_max::numeric > e.pz_min::numeric * 1.10       THEN 'PREZZO_INCOMPATIBILE' END,
      CASE WHEN e.has_asta                                         THEN 'ASTA_O_PROCEDURA' END,
      CASE WHEN e.has_mls AND e.n_agenzie > 1                      THEN 'MLS_INCOMPATIBILE' END,
      CASE WHEN NOT (
             (e.n_civico = e.n_rows AND e.d_civico = 1)
          OR (e.n_fp    = e.n_rows AND e.d_fp    = 1)
           )                                                       THEN 'EVIDENZA_UNITA_ASSENTE' END
    ], NULL) AS motivi
  FROM _mp_eval e;

  DELETE FROM public.padova_multi_portale_quarantena;

  INSERT INTO public.padova_multi_portale_quarantena
    (chiave_match, portals_seen, portal_count, agenzie, prezzo_min, prezzo_max,
     mq, locali, bagni, quartiere, commercial_zone_slug, urls, n_annunci,
     motivi, metriche)
  SELECT v.chiave_match, v.portals_seen, v.portal_count, v.agenzie,
         v.prezzo_min, v.prezzo_max, v.mq, v.locali, v.bagni, v.quartiere,
         v.commercial_zone_slug, v.urls, v.n_annunci, v.motivi,
         jsonb_build_object(
           'n_rows', v.n_rows, 'n_portali', v.n_portali, 'n_agenzie', v.n_agenzie,
           'vie_distinte', v.d_via, 'civici_valorizzati', v.n_civico,
           'civici_distinti', v.d_civico, 'fingerprint_valorizzati', v.n_fp,
           'fingerprint_distinti', v.d_fp, 'piani_distinti', v.d_piano,
           'mq_min', v.mq_min, 'mq_max', v.mq_max,
           'prezzo_min', v.pz_min, 'prezzo_max', v.pz_max,
           'asta', v.has_asta, 'mls', v.has_mls,
           'urls', to_jsonb(v.urls))
  FROM _mp_verdict v
  WHERE array_length(v.motivi, 1) IS NOT NULL;

  DELETE FROM public.padova_multi_portale mp
   WHERE EXISTS (
     SELECT 1 FROM _mp_verdict v
      WHERE v.chiave_match = mp.chiave_match
        AND array_length(v.motivi, 1) IS NOT NULL
   );

  SELECT count(*) INTO v_after FROM public.padova_multi_portale;
  SELECT count(*) INTO v_quar  FROM public.padova_multi_portale_quarantena;

  IF EXISTS (
    SELECT 1 FROM public.padova_multi_portale mp
     JOIN _mp_verdict v ON v.chiave_match = mp.chiave_match
     WHERE array_length(v.motivi, 1) IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'QA multi-portale fallita: gruppi non certificati ancora pubblici';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'gate_version', 'mp-unit-certified-v1',
    'multi_portale_before', v_before,
    'multi_portale_certificati', v_after,
    'multi_portale_quarantena', v_quar
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.padova_certify_multi_portale() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.padova_certify_multi_portale() TO service_role;

-- Applicazione automatica ad ogni ricalcolo: trigger statement-level.
CREATE OR REPLACE FUNCTION public.padova_multi_portale_certify_tg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $tg$
BEGIN
  PERFORM public.padova_certify_multi_portale();
  RETURN NULL;
END;
$tg$;

DROP TRIGGER IF EXISTS trg_padova_multi_portale_certify ON public.padova_multi_portale;
CREATE TRIGGER trg_padova_multi_portale_certify
AFTER INSERT ON public.padova_multi_portale
FOR EACH STATEMENT
EXECUTE FUNCTION public.padova_multi_portale_certify_tg();