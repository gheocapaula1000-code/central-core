
-- 1) Tabella di quarantena per metrature sospette
CREATE TABLE IF NOT EXISTS public.padova_contendibili_quarantena (
  id            bigserial PRIMARY KEY,
  chiave_match  text,
  n_agenzie     int,
  agenzie       text[],
  fonti         text[],
  confidenza    text,
  prezzo_min    int,
  prezzo_max    int,
  mq            int,
  locali        int,
  bagni         int,
  quartiere     text,
  lat           double precision,
  lng           double precision,
  urls          text[],
  n_annunci     int,
  motivo        text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.padova_contendibili_quarantena TO authenticated;
GRANT ALL ON public.padova_contendibili_quarantena TO service_role;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.padova_contendibili_quarantena_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.padova_contendibili_quarantena_id_seq TO service_role;

ALTER TABLE public.padova_contendibili_quarantena ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins only on quarantena" ON public.padova_contendibili_quarantena;
CREATE POLICY "Admins only on quarantena"
  ON public.padova_contendibili_quarantena
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 2) Helper: canonicalizzazione URL (rimuove query, fragment, www, normalizza scheme/host/path)
CREATE OR REPLACE FUNCTION public.canon_url(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  s text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  s := trim(p);
  IF s = '' THEN RETURN NULL; END IF;
  -- togli fragment e query
  s := regexp_replace(s, '#.*$', '');
  s := regexp_replace(s, '\?.*$', '');
  -- normalizza scheme
  s := regexp_replace(s, '^http://', 'https://', 'i');
  -- togli www.
  s := regexp_replace(s, '^https://www\.', 'https://', 'i');
  -- lowercase host (path resta case-sensitive sui portali)
  s := regexp_replace(
         s,
         '^(https://)([^/]+)(.*)$',
         '\1' || lower((regexp_match(s, '^https://([^/]+)'))[1]) || '\3'
       );
  -- togli trailing slash multipli
  s := regexp_replace(s, '/+$', '');
  RETURN s;
END;
$fn$;

-- 3) Helper: quartiere canonico (token principale, prima parte prima di " / ")
CREATE OR REPLACE FUNCTION public.canon_quartiere(p text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $fn$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    ELSE trim(lower(translate(split_part(p, '/', 1),
      'àáâãäåèéêëìíîïòóôõöùúûüýÿñç',
      'aaaaaaeeeeiiiiooooouuuuyync')))
  END;
$fn$;

-- 4) Funzione principale: pulisce e fonde i contendibili esistenti
CREATE OR REPLACE FUNCTION public.merge_padova_contendibili()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_before_total int;
  v_quarantena   int := 0;
  v_url_before   int := 0;
  v_url_after    int := 0;
  v_after_total  int;
  v_done         boolean := false;
  v_merged_pass  int;
  v_passes       int := 0;
BEGIN
  SELECT count(*) INTO v_before_total FROM public.padova_contendibili;

  -- A) URL canonical + dedup interno per riga
  SELECT COALESCE(sum(coalesce(array_length(urls,1),0)),0) INTO v_url_before
    FROM public.padova_contendibili;

  UPDATE public.padova_contendibili p
     SET urls = sub.canon_urls
    FROM (
      SELECT id,
             (SELECT array_agg(DISTINCT u ORDER BY u)
                FROM (SELECT public.canon_url(unnest(urls)) AS u) x
               WHERE u IS NOT NULL) AS canon_urls
        FROM public.padova_contendibili
    ) sub
   WHERE p.id = sub.id;

  -- Dedup agenzie (normalizzate) preservando display name più lungo
  UPDATE public.padova_contendibili p
     SET agenzie = sub.dedup
    FROM (
      SELECT id, array_agg(name ORDER BY name) AS dedup
        FROM (
          SELECT id,
                 (array_agg(orig ORDER BY length(orig) DESC, orig))[1] AS name
            FROM (
              SELECT id, unnest(agenzie) AS orig,
                     public.norm_agency(unnest(agenzie)) AS keyn
                FROM public.padova_contendibili
            ) y
           GROUP BY id, keyn
        ) z
       GROUP BY id
    ) sub
   WHERE p.id = sub.id;

  -- Aggiorna n_agenzie e n_annunci coerenti
  UPDATE public.padova_contendibili
     SET n_agenzie = COALESCE(array_length(agenzie::text[],1),0),
         n_annunci = COALESCE(array_length(urls::text[],1),0)
   WHERE true;

  SELECT COALESCE(sum(coalesce(array_length(urls,1),0)),0) INTO v_url_after
    FROM public.padova_contendibili;

  -- B) Quarantena metrature sospette
  WITH bad AS (
    SELECT id, chiave_match, n_agenzie, agenzie, fonti, confidenza, prezzo_min, prezzo_max,
           mq, locali, bagni, quartiere, lat, lng, urls, n_annunci,
           CASE
             WHEN mq < 25 AND locali >= 2 THEN 'mq<25_con_locali>=2'
             WHEN mq < 35 AND bagni >= 2 THEN 'mq<35_con_bagni>=2'
             WHEN locali > 0 AND mq::numeric / locali < 12 THEN 'mq_per_locale<12'
             WHEN locali > 0 AND mq::numeric / locali > 80 THEN 'mq_per_locale>80'
           END AS motivo
      FROM public.padova_contendibili
     WHERE (mq < 25 AND locali >= 2)
        OR (mq < 35 AND bagni >= 2)
        OR (locali > 0 AND mq::numeric / locali < 12)
        OR (locali > 0 AND mq::numeric / locali > 80)
  ), ins AS (
    INSERT INTO public.padova_contendibili_quarantena
      (chiave_match, n_agenzie, agenzie, fonti, confidenza, prezzo_min, prezzo_max,
       mq, locali, bagni, quartiere, lat, lng, urls, n_annunci, motivo)
    SELECT chiave_match, n_agenzie, agenzie, fonti, confidenza, prezzo_min, prezzo_max,
           mq, locali, bagni, quartiere, lat, lng, urls, n_annunci, motivo
      FROM bad
    RETURNING 1
  ),
  del AS (
    DELETE FROM public.padova_contendibili WHERE id IN (SELECT id FROM bad) RETURNING 1
  )
  SELECT count(*) INTO v_quarantena FROM ins;

  -- C) Fuzzy merge a passaggi successivi finché non si fonde più nulla
  LOOP
    v_passes := v_passes + 1;
    EXIT WHEN v_passes > 8;

    WITH pairs AS (
      SELECT a.id AS keep_id, b.id AS drop_id
        FROM public.padova_contendibili a
        JOIN public.padova_contendibili b
          ON a.id < b.id
         AND public.canon_quartiere(a.quartiere) IS NOT NULL
         AND public.canon_quartiere(a.quartiere) = public.canon_quartiere(b.quartiere)
         AND COALESCE(a.bagni,-1) = COALESCE(b.bagni,-1)
         AND abs(COALESCE(a.locali,0) - COALESCE(b.locali,0)) <= 1
         AND (
              (a.mq <= 200 AND abs(a.mq - b.mq) <= 5)
           OR (a.mq >  200 AND abs(a.mq - b.mq)::numeric / a.mq <= 0.05)
         )
         -- sovrapposizione prezzi >=90% del range minore
         AND (
              -- punto-punto identico
              (a.prezzo_min = a.prezzo_max AND b.prezzo_min = b.prezzo_max AND a.prezzo_min = b.prezzo_min)
           OR (
                LEAST(a.prezzo_max, b.prezzo_max) >= GREATEST(a.prezzo_min, b.prezzo_min)
                AND (LEAST(a.prezzo_max, b.prezzo_max) - GREATEST(a.prezzo_min, b.prezzo_min))::numeric
                    >= 0.90 * LEAST(
                        GREATEST(a.prezzo_max - a.prezzo_min, 1),
                        GREATEST(b.prezzo_max - b.prezzo_min, 1)
                      )
              )
           OR (
                -- entrambi punto: tolleranza 1% se mq/locali matchano
                a.prezzo_min = a.prezzo_max AND b.prezzo_min = b.prezzo_max
                AND abs(a.prezzo_min - b.prezzo_min)::numeric / GREATEST(a.prezzo_min,1) <= 0.01
              )
         )
    ),
    -- ogni drop_id viene assegnato a UN solo keep_id (il più piccolo)
    chosen AS (
      SELECT drop_id, MIN(keep_id) AS keep_id FROM pairs GROUP BY drop_id
    ),
    -- evita catene multiple in un singolo pass
    safe AS (
      SELECT c.* FROM chosen c
      WHERE NOT EXISTS (SELECT 1 FROM chosen c2 WHERE c2.drop_id = c.keep_id)
    ),
    merged AS (
      UPDATE public.padova_contendibili tgt
         SET urls = (
               SELECT array_agg(DISTINCT u ORDER BY u)
                 FROM (
                   SELECT public.canon_url(unnest(tgt.urls || src.urls)) AS u
                 ) x WHERE u IS NOT NULL
             ),
             agenzie = (
               SELECT array_agg(name ORDER BY name) FROM (
                 SELECT (array_agg(orig ORDER BY length(orig) DESC, orig))[1] AS name
                   FROM (SELECT unnest(tgt.agenzie || src.agenzie) AS orig,
                                public.norm_agency(unnest(tgt.agenzie || src.agenzie)) AS k) y
                  GROUP BY k
               ) z
             ),
             fonti = (
               SELECT array_agg(DISTINCT f ORDER BY f) FROM unnest(tgt.fonti || src.fonti) AS f
             ),
             prezzo_min = LEAST(tgt.prezzo_min, src.prezzo_min),
             prezzo_max = GREATEST(tgt.prezzo_max, src.prezzo_max),
             mq         = ((tgt.mq + src.mq) / 2)::int,
             locali     = GREATEST(tgt.locali, src.locali),
             confidenza = CASE
                            WHEN tgt.confidenza = 'ALTA' OR src.confidenza = 'ALTA' THEN 'ALTA'
                            WHEN tgt.confidenza = 'MEDIA' OR src.confidenza = 'MEDIA' THEN 'MEDIA'
                            ELSE COALESCE(tgt.confidenza, src.confidenza)
                          END
        FROM safe s
        JOIN public.padova_contendibili src ON src.id = s.drop_id
       WHERE tgt.id = s.keep_id
      RETURNING tgt.id
    ),
    del AS (
      DELETE FROM public.padova_contendibili WHERE id IN (SELECT drop_id FROM safe) RETURNING 1
    )
    SELECT count(*) INTO v_merged_pass FROM del;

    EXIT WHEN COALESCE(v_merged_pass,0) = 0;
  END LOOP;

  -- Ricalcola n_agenzie/n_annunci finali
  UPDATE public.padova_contendibili
     SET n_agenzie = COALESCE(array_length(agenzie,1),0),
         n_annunci = COALESCE(array_length(urls,1),0);

  -- D) Sgancia prezzi puntuali sospetti (n_agenzie >= 5 con prezzo_min = prezzo_max):
  --    ricalcola la forchetta dai prezzi reali dei listing collegati via URL canonico
  WITH targets AS (
    SELECT id, urls
      FROM public.padova_contendibili
     WHERE n_agenzie >= 5 AND prezzo_min = prezzo_max
  ),
  src AS (
    SELECT t.id, MIN(l.prezzo)::int AS pmin, MAX(l.prezzo)::int AS pmax
      FROM targets t
      JOIN public.padova_listings l
        ON public.canon_url(l.url) = ANY (t.urls)
     WHERE l.prezzo IS NOT NULL AND l.prezzo > 0
     GROUP BY t.id
     HAVING MIN(l.prezzo) <> MAX(l.prezzo)
  )
  UPDATE public.padova_contendibili p
     SET prezzo_min = src.pmin,
         prezzo_max = src.pmax
    FROM src WHERE p.id = src.id;

  SELECT count(*) INTO v_after_total FROM public.padova_contendibili;

  RETURN jsonb_build_object(
    'ok', true,
    'prima_totale', v_before_total,
    'dopo_totale', v_after_total,
    'fusi', v_before_total - v_after_total - v_quarantena,
    'quarantena', v_quarantena,
    'passes', v_passes,
    'urls_prima', v_url_before,
    'urls_dopo',  v_url_after,
    'urls_deduplicati', v_url_before - v_url_after
  );
END;
$fn$;
