
-- ═══════════════════════════════════════════════════════════════
-- P1-B — Recupero evidenze unità a costo zero
-- ═══════════════════════════════════════════════════════════════

-- 1) Colonne derivate (mai sovrascrivono i dati sorgente)
ALTER TABLE public.padova_listings
  ADD COLUMN IF NOT EXISTS ev_via_norm      text,
  ADD COLUMN IF NOT EXISTS ev_civico_norm   text,
  ADD COLUMN IF NOT EXISTS ev_piano_key     text,
  ADD COLUMN IF NOT EXISTS ev_descr_fp      text,
  ADD COLUMN IF NOT EXISTS ev_image_refs    jsonb,
  ADD COLUMN IF NOT EXISTS ev_provenance    jsonb,
  ADD COLUMN IF NOT EXISTS ev_derived_at    timestamptz;

CREATE INDEX IF NOT EXISTS padova_listings_ev_ident_idx
  ON public.padova_listings (ev_via_norm, ev_civico_norm)
  WHERE ev_via_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS padova_listings_ev_pending_idx
  ON public.padova_listings (id) WHERE ev_derived_at IS NULL;

-- 2) Etichette di quartiere: non possono mai diventare una via
CREATE OR REPLACE FUNCTION public.padova_is_quartiere_label(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
  WITH t AS (
    SELECT unnest(regexp_split_to_array(
      btrim(translate(lower(coalesce(p,'')),
        'àáâãäåèéêëìíîïòóôõöùúûüýÿñç','aaaaaaeeeeiiiiooooouuuuyync')),
      '\s*[,;/]\s*')) AS part
  )
  SELECT coalesce(bool_and(
    part = '' OR part = ANY (ARRAY[
      'arcella','centro storico','centro','piazze','duomo','santo','santa sofia',
      'altinate','savonarola','ponte molino','portello','san carlo',
      'pontevigodarzere','sacra famiglia','brusegana','cave','monta','ponterotto',
      'san bellino','mortise','torre','san lazzaro','stanga','forcellini',
      'santa rita','voltabarozzo','salboro','guizza','mandria','sant''osvaldo',
      'santosvaldo','chiesanuova','paltana','madonna pellegrina','crocefisso',
      'bassanello','citta giardino','san giuseppe','sant''ignazio','santignazio',
      'isola di terranegra','terranegra','camin','granze','zona industriale',
      'fiera','stazione','prato della valle','san prosdocimo','borgomagno',
      'est brenta','padova','veneto'
    ])), false)
  FROM t;
$$;

-- 3) Estrazione odonimo ancorata (mai un quartiere)
CREATE OR REPLACE FUNCTION public.padova_extract_via(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
DECLARE
  v_pref constant text :=
    'via|viale|v\.le|piazza|p\.zza|piazzale|p\.le|corso|c\.so|largo|vicolo|strada|stradella|borgo|lungargine|riviera|salita|calle|contrada|passaggio|galleria|rotonda';
  m text[];
  cand text;
  nome text;
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RETURN NULL; END IF;
  m := regexp_match(p,
    '(?i)\m(' || v_pref || ')\s+([A-Za-zÀ-ÿ0-9''’\.\-]+(?:\s+[A-Za-zÀ-ÿ0-9''’\.\-]+){0,4})');
  IF m IS NULL THEN RETURN NULL; END IF;
  nome := btrim(regexp_replace(m[2], '[\s,;\.\-]+$', ''));
  IF nome = '' OR public.padova_is_quartiere_label(nome) THEN RETURN NULL; END IF;
  IF length(regexp_replace(lower(nome), '[^a-zà-ÿ]', '', 'g')) < 3 THEN RETURN NULL; END IF;
  cand := m[1] || ' ' || nome;
  RETURN left(cand, 200);
END;
$$;

-- 4) Chiave via normalizzata derivata (fail-closed sui quartieri)
CREATE OR REPLACE FUNCTION public.padova_via_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
  SELECT CASE
    WHEN p IS NULL OR btrim(p) = '' THEN NULL
    WHEN public.padova_is_quartiere_label(p) THEN NULL
    WHEN public.norm_via(p) IN ('', 'na') THEN NULL
    WHEN length(regexp_replace(public.norm_via(p), '[^a-z]', '', 'g')) < 3 THEN NULL
    ELSE public.norm_via(p)
  END;
$$;

-- 5) Civico: normalizzazione + validazione (no CAP/prezzo/mq/anno/telefono/id)
CREATE OR REPLACE FUNCTION public.padova_civico_norm(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
DECLARE c text; d text; n int;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  c := regexp_replace(lower(btrim(p)), '[^a-z0-9]', '', 'g');
  IF c = '' OR length(c) > 5 THEN RETURN NULL; END IF;
  d := regexp_replace(c, '[^0-9]', '', 'g');
  IF d = '' OR length(d) >= 4 THEN RETURN NULL; END IF; -- CAP, anno, prezzo, id
  n := d::int;
  IF n <= 0 OR n > 999 THEN RETURN NULL; END IF;
  RETURN c;
END;
$$;

-- 6) Civico da testo: solo se legato sintatticamente all'odonimo
CREATE OR REPLACE FUNCTION public.padova_extract_civico(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
DECLARE
  v_pref constant text :=
    'via|viale|v\.le|piazza|p\.zza|piazzale|p\.le|corso|c\.so|largo|vicolo|strada|stradella|borgo|lungargine|riviera|salita|calle|contrada|passaggio|galleria|rotonda';
  m text[];
  pos int;
  tail text;
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RETURN NULL; END IF;
  m := regexp_match(p,
    '(?i)\m(?:' || v_pref || ')\s+[A-Za-zÀ-ÿ''’\.\-]+(?:\s+[A-Za-zÀ-ÿ''’\.\-]+){0,4}[\s,]*(?:n\.?|nr\.?|civico|civ\.?)?\s*(\d{1,3}\s*/?\s*[a-zA-Z]?)\m');
  IF m IS NULL THEN RETURN NULL; END IF;
  pos := strpos(p, m[1]);
  IF pos > 0 THEN
    tail := substr(p, pos + length(m[1]), 12);
    IF tail ~* '^\s*(m²|mq|m2|mc|€|euro|eur|local|van|camer|bagn|piano|piani|%|km|anno|posti|classe)' THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN public.padova_civico_norm(m[1]);
END;
$$;

-- 7) Piano derivato v2: aggiunge features_floor_values (subito),
--    casa.it `floor`, idealista `floor`, immobiliare mainData e testo.
CREATE OR REPLACE FUNCTION public.padova_piano_key_norm(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
DECLARE v text; n int;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  v := btrim(translate(lower(p),'àáâãäåèéêëìíîïòóôõöùúûüýÿñç','aaaaaaeeeeiiiiooooouuuuyync'));
  IF v = '' THEN RETURN NULL; END IF;
  IF v ~ 'seminterrat|interrat|scantinat|sottosuolo' THEN RETURN 'S'; END IF;
  IF v ~ 'rialzat' THEN RETURN 'R'; END IF;
  IF v ~ 'piano terra|\mterra\M|^t$|^pt$' THEN RETURN 'T'; END IF;
  IF v ~ 'mansard' THEN RETURN 'M'; END IF;
  IF v ~ 'attico|ultimo' THEN RETURN 'A'; END IF;
  IF v ~ '\mprimo\M'   THEN RETURN 'P1'; END IF;
  IF v ~ '\msecondo\M' THEN RETURN 'P2'; END IF;
  IF v ~ '\mterzo\M'   THEN RETURN 'P3'; END IF;
  IF v ~ '\mquarto\M'  THEN RETURN 'P4'; END IF;
  IF v ~ '\mquinto\M'  THEN RETURN 'P5'; END IF;
  IF v ~ '\msesto\M'   THEN RETURN 'P6'; END IF;
  IF v ~ '\msettimo\M' THEN RETURN 'P7'; END IF;
  IF v ~ '\mottavo\M'  THEN RETURN 'P8'; END IF;
  IF v ~ '\mnono\M'    THEN RETURN 'P9'; END IF;
  IF v ~ '\mdecimo\M'  THEN RETURN 'P10'; END IF;
  IF v ~ '[0-9]' THEN
    n := (substring(v from '([0-9]{1,2})'))::int;
    IF n < 0 OR n > 40 THEN RETURN NULL; END IF;
    IF n = 0 THEN RETURN 'T'; END IF;
    RETURN 'P' || n::text;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.padova_piano_from_text(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
DECLARE t text; m text[];
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  t := translate(lower(p),'àáâãäåèéêëìíîïòóôõöùúûüýÿñç','aaaaaaeeeeiiiiooooouuuuyync');
  IF t ~ 'piano nobile' THEN RETURN NULL; END IF;
  m := regexp_match(t, '\m(?:al|allo)\s+(\d{1,2})\s*[°ºo]?\s*piano\M');
  IF m IS NOT NULL THEN RETURN public.padova_piano_key_norm(m[1]); END IF;
  m := regexp_match(t, '\mpiano\s+(terra|rialzato|seminterrato|interrato|primo|secondo|terzo|quarto|quinto|sesto|settimo|ottavo|nono|decimo|ultimo)\M');
  IF m IS NOT NULL THEN RETURN public.padova_piano_key_norm(m[1]); END IF;
  m := regexp_match(t, '\m(\d{1,2})\s*[°º]\s*piano\M');
  IF m IS NOT NULL THEN RETURN public.padova_piano_key_norm(m[1]); END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.padova_unit_floor_key_v2(p_raw jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
  SELECT coalesce(
    -- strutturato: immobiliare mainData → subito features_floor_values →
    -- casa.it floor → idealista floor
    public.padova_piano_key_norm((
      SELECT r->>'value'
        FROM jsonb_array_elements(COALESCE(p_raw->'mainData','[]'::jsonb)) s,
             jsonb_array_elements(COALESCE(s->'rows','[]'::jsonb)) r
       WHERE r->>'label' = 'Piano' LIMIT 1)),
    public.padova_piano_key_norm(NULLIF(btrim(p_raw->>'features_floor_values'),'')),
    public.padova_piano_key_norm(NULLIF(btrim(p_raw->>'floor'),'')),
    public.padova_piano_key_norm(NULLIF(btrim(p_raw->'features'->>'floor'),'')),
    -- testuale, con contesto esplicito
    public.padova_piano_from_text(
      COALESCE(p_raw->>'body', p_raw->>'description',
               p_raw->'description'->>'content'))
  );
$$;

-- 8) Descrizione normalizzata + impronta deterministica
CREATE OR REPLACE FUNCTION public.padova_descr_norm(p text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
  SELECT NULLIF(btrim(regexp_replace(
    regexp_replace(
      translate(lower(coalesce(p,'')),'àáâãäåèéêëìíîïòóôõöùúûüýÿñç','aaaaaaeeeeiiiiooooouuuuyync'),
      '(rif\.?\s*(interno|agenzia)?\s*[:n°\.]*\s*[a-z0-9\-/]{2,15})|((tel|telefono|cell|cellulare|whatsapp)\.?\s*[:\.]?\s*\+?[0-9\s\./-]{6,})|([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})|(https?://\S+)|(www\.\S+)|(re/max|remax|tecnocasa|gabetti|tempocasa|professionecasa|grimaldi|toscano)|(open house|contattaci|contattateci|chiamaci|per informazioni|maggiori informazioni)|(classe energetica[^\.]*)',
      ' ', 'g'),
    '[^a-z0-9]+', ' ', 'g')), '');
$$;

CREATE OR REPLACE FUNCTION public.padova_descr_fp(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
DECLARE norm text; compact text; distinct_tokens int;
BEGIN
  norm := public.padova_descr_norm(p);
  IF norm IS NULL THEN RETURN NULL; END IF;
  compact := replace(norm, ' ', '');
  IF length(compact) < 160 THEN RETURN NULL; END IF;
  SELECT count(DISTINCT tok) INTO distinct_tokens
    FROM unnest(string_to_array(norm, ' ')) tok WHERE length(tok) > 3;
  IF distinct_tokens < 12 THEN RETURN NULL; END IF;
  RETURN md5(left(compact, 400));
END;
$$;

-- 9) Backfill idempotente a lotti, solo da dati già presenti
CREATE OR REPLACE FUNCTION public.padova_backfill_unit_evidence(
  p_batch int DEFAULT 500,
  p_force boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public' SET statement_timeout TO '55s' SET lock_timeout TO '3s'
AS $$
DECLARE v_rows int := 0;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  WITH todo AS (
    SELECT l.id FROM public.padova_listings l
     WHERE p_force OR l.ev_derived_at IS NULL
     ORDER BY l.id
     LIMIT greatest(1, least(coalesce(p_batch,500), 5000))
     FOR UPDATE SKIP LOCKED
  ),
  src AS (
    SELECT l.id, l.fonte, l.indirizzo, l.raw_json,
           cs.raw_json AS casa_stg,
           ids.raw_json AS imm_stg
      FROM public.padova_listings l
      JOIN todo t ON t.id = l.id
      LEFT JOIN LATERAL (
        SELECT s.raw_json FROM public.padova_casa_staging s
         WHERE l.fonte = 'casa' AND s.raw_json->>'url' = l.url
         ORDER BY s.fetched_at DESC LIMIT 1) cs ON true
      LEFT JOIN LATERAL (
        SELECT s.raw_json FROM public.padova_immobiliare_detail_staging s
         WHERE l.fonte = 'immobiliare' AND s.url = l.url
         ORDER BY s.fetched_at DESC LIMIT 1) ids ON true
  ),
  calc AS (
    SELECT s.id,
      -- via: strutturato > semi-strutturato > testuale
      CASE
        WHEN NULLIF(btrim(s.raw_json#>>'{geography,street}'),'') IS NOT NULL
          THEN jsonb_build_object('v', s.raw_json#>>'{geography,street}',
               'src','raw_json.geography.street','rel','structured')
        WHEN NULLIF(btrim(s.imm_stg#>>'{geography,street}'),'') IS NOT NULL
          THEN jsonb_build_object('v', s.imm_stg#>>'{geography,street}',
               'src','immobiliare_detail_staging.geography.street','rel','structured')
        WHEN NULLIF(btrim(s.raw_json->>'street'),'') IS NOT NULL
          THEN jsonb_build_object('v', s.raw_json->>'street',
               'src','raw_json.street','rel','structured')
        WHEN NULLIF(btrim(s.raw_json#>>'{ubication,title}'),'') IS NOT NULL
          THEN jsonb_build_object('v', s.raw_json#>>'{ubication,title}',
               'src','raw_json.ubication.title','rel','semi_structured')
        WHEN public.padova_extract_via(s.indirizzo) IS NOT NULL
          THEN jsonb_build_object('v', public.padova_extract_via(s.indirizzo),
               'src','padova_listings.indirizzo','rel','semi_structured')
        WHEN public.padova_extract_via(COALESCE(s.raw_json->>'title', s.raw_json->>'subject',
             s.raw_json#>>'{title,main}', s.casa_stg#>>'{title,main}')) IS NOT NULL
          THEN jsonb_build_object('v', public.padova_extract_via(COALESCE(s.raw_json->>'title',
               s.raw_json->>'subject', s.raw_json#>>'{title,main}', s.casa_stg#>>'{title,main}')),
               'src','title','rel','textual')
        WHEN public.padova_extract_via(COALESCE(s.casa_stg->>'description',
             s.raw_json->>'description', s.raw_json->>'body',
             s.imm_stg#>>'{description,content}')) IS NOT NULL
          THEN jsonb_build_object('v', public.padova_extract_via(COALESCE(s.casa_stg->>'description',
               s.raw_json->>'description', s.raw_json->>'body', s.imm_stg#>>'{description,content}')),
               'src','description','rel','textual')
        ELSE NULL
      END AS via_ev,
      s.fonte, s.indirizzo, s.raw_json, s.casa_stg, s.imm_stg
    FROM src s
  ),
  calc2 AS (
    SELECT c.*,
      public.padova_via_key(c.via_ev->>'v') AS via_key,
      COALESCE(
        public.padova_extract_civico(c.via_ev->>'v'),
        public.padova_extract_civico(c.indirizzo),
        public.padova_extract_civico(c.raw_json#>>'{ubication,title}'),
        public.padova_extract_civico(c.raw_json->>'geo_map_address')
      ) AS civico_key,
      public.padova_unit_floor_key_v2(
        CASE WHEN c.imm_stg IS NOT NULL THEN c.raw_json || c.imm_stg ELSE c.raw_json END
      ) AS piano_key,
      public.padova_descr_norm(COALESCE(
        c.casa_stg->>'description', c.raw_json->>'description',
        c.raw_json->>'body', c.imm_stg#>>'{description,content}',
        c.raw_json#>>'{description,content}')) AS descr_norm,
      public.padova_descr_fp(COALESCE(
        c.casa_stg->>'description', c.raw_json->>'description',
        c.raw_json->>'body', c.imm_stg#>>'{description,content}',
        c.raw_json#>>'{description,content}')) AS descr_fp
    FROM calc c
  )
  UPDATE public.padova_listings l
     SET ev_via_norm    = c.via_key,
         ev_civico_norm = CASE WHEN c.via_key IS NOT NULL THEN c.civico_key ELSE NULL END,
         ev_piano_key   = c.piano_key,
         ev_descr_fp    = c.descr_fp,
         ev_image_refs  = NULL,
         ev_provenance  = jsonb_strip_nulls(jsonb_build_object(
             'via', c.via_ev,
             'civico', CASE WHEN c.via_key IS NOT NULL AND c.civico_key IS NOT NULL
                            THEN jsonb_build_object('v', c.civico_key, 'rel','derived_from_via') END,
             'piano', CASE WHEN c.piano_key IS NOT NULL
                           THEN jsonb_build_object('v', c.piano_key, 'rel','structured_or_context') END,
             'descr', CASE WHEN c.descr_fp IS NOT NULL
                           THEN jsonb_build_object('len', length(coalesce(c.descr_norm,'')), 'rel','textual') END,
             'version', 'p1b-v1')),
         ev_derived_at  = now()
    FROM calc2 c
   WHERE l.id = c.id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'processed', v_rows,
    'remaining', (SELECT count(*) FROM public.padova_listings WHERE ev_derived_at IS NULL));
END;
$$;

REVOKE ALL ON FUNCTION public.padova_backfill_unit_evidence(int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.padova_backfill_unit_evidence(int, boolean) TO service_role;
