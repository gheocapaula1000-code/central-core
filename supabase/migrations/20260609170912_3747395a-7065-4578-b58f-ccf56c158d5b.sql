
ALTER TABLE public.padova_collect_v2_items
  ADD COLUMN IF NOT EXISTS mq integer,
  ADD COLUMN IF NOT EXISTS locali integer,
  ADD COLUMN IF NOT EXISTS piano text,
  ADD COLUMN IF NOT EXISTS bagni integer,
  ADD COLUMN IF NOT EXISTS agency text,
  ADD COLUMN IF NOT EXISTS civico text,
  ADD COLUMN IF NOT EXISTS tipologia text,
  ADD COLUMN IF NOT EXISTS riscaldamento text,
  ADD COLUMN IF NOT EXISTS anno_costruzione integer,
  ADD COLUMN IF NOT EXISTS stato text,
  ADD COLUMN IF NOT EXISTS cluster_key text,
  ADD COLUMN IF NOT EXISTS raw_json jsonb;

CREATE INDEX IF NOT EXISTS idx_cluster_key ON public.padova_collect_v2_items (cluster_key);
CREATE INDEX IF NOT EXISTS idx_url ON public.padova_collect_v2_items (url);

CREATE OR REPLACE FUNCTION public.compute_cluster_key(
  p_via text,
  p_civico text,
  p_mq integer,
  p_locali integer
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_via text;
  v_civ text;
  v_mq  text;
  v_loc text;
BEGIN
  v_via := lower(coalesce(p_via, ''));
  -- rimuovi accenti
  v_via := translate(v_via,
    'àáâãäåèéêëìíîïòóôõöùúûüýÿñç',
    'aaaaaaeeeeiiiiooooouuuuyync');
  -- rimuovi prefissi toponimici
  v_via := regexp_replace(v_via,
    '^(via|viale|v\.le|piazza|p\.zza|piazzale|p\.le|corso|c\.so|largo|vicolo|strada|str\.|borgo|lungargine|riviera|salita|calle|contra|contrada|stradella|passaggio)\s+',
    '', 'i');
  -- collassa non-alfanumerici in trattino
  v_via := regexp_replace(v_via, '[^a-z0-9]+', '-', 'g');
  v_via := trim(both '-' from v_via);
  IF v_via = '' THEN v_via := 'na'; END IF;

  v_civ := lower(trim(coalesce(p_civico, '')));
  IF v_civ = '' THEN v_civ := 'sn'; END IF;
  v_civ := regexp_replace(v_civ, '[^a-z0-9]+', '', 'g');
  IF v_civ = '' THEN v_civ := 'sn'; END IF;

  IF p_mq IS NULL OR p_mq <= 0 THEN
    v_mq := 'na';
  ELSE
    v_mq := (round(p_mq::numeric / 10.0) * 10)::int::text;
  END IF;

  IF p_locali IS NULL OR p_locali <= 0 THEN
    v_loc := 'na';
  ELSE
    v_loc := p_locali::text;
  END IF;

  RETURN v_via || '|' || v_civ || '|' || v_mq || '|' || v_loc;
END;
$$;
