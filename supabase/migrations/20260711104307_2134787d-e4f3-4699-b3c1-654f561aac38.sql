-- Estende norm_via con normalizzazioni finali e guardia chiavi generiche nel recompute wrapper.

CREATE OR REPLACE FUNCTION public.norm_via(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            CASE
              WHEN base ~ '-in-(via|corso|piazza|piazzale|vicolo|riviera)-'
                THEN regexp_replace(base, '^.*-in-(via|corso|piazza|piazzale|vicolo|riviera)-', '')
              ELSE base
            END,
            '-padova$', ''
          ),
          '-(no-number|nn)$', ''
        ),
        '^(appartamento|flat|apartment|trilocale|bilocale|quadrilocale|monolocale|quadrilocale-in)-', ''
      ),
      '^-+|-+$', '', 'g'
    )
  FROM (
    SELECT trim(both '-' from regexp_replace(
      regexp_replace(
        translate(lower(coalesce(p,'')),
          'àáâãäåèéêëìíîïòóôõöùúûüýÿñç',
          'aaaaaaeeeeiiiiooooouuuuyync'),
        '^(via|viale|v\.le|piazza|p\.zza|piazzale|p\.le|corso|c\.so|largo|vicolo|strada|str\.|borgo|lungargine|riviera|salita|calle|contra|contrada|stradella|passaggio)\s+','','i'),
      '[^a-z0-9]+','-','g')) AS base
  ) s
$function$;

CREATE OR REPLACE FUNCTION public.recompute_padova_contendibili()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_r1 jsonb;
  v_r2 jsonb;
  v_generic int := 0;
BEGIN
  v_r1 := public.recompute_padova_listings_contendibili();

  -- Guardia chiavi generiche: gruppi la cui "via" è una tipologia o una zona anonima
  DELETE FROM public.padova_contendibili
  WHERE split_part(chiave_match, '|', 1) IN
        ('appartamento','appartamenti','annuncio','immobile','casa','villa','asta',
         'trilocale','bilocale','quadrilocale','monolocale','attico','mansarda',
         'loft','flat','room','terreno','ufficio','negozio')
     OR split_part(chiave_match, '|', 1) LIKE 'neighbourhood%';
  GET DIAGNOSTICS v_generic = ROW_COUNT;

  v_r2 := public.recompute_padova_contendibili_extras();

  RETURN jsonb_build_object(
    'ok', true,
    'clustering', v_r1,
    'extras', v_r2,
    'sanitized_bad_coords', COALESCE((v_r1->>'sanitized_bad_coords')::int, 0),
    'excluded_bad_title',   COALESCE((v_r1->>'excluded_bad_title')::int, 0),
    'excluded_generic_key', v_generic
  );
END;
$function$;