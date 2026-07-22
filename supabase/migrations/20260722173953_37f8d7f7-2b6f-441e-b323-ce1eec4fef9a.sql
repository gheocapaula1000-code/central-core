
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
  v_unmapped int := 0;
BEGIN
  -- Alcuni client (PostgREST/pgbouncer) impostano sql_safe_updates=on
  -- e rifiutano UPDATE con WHERE in forma FROM-join. Disattiviamolo per la transazione.
  PERFORM set_config('session_replication_role', current_setting('session_replication_role'), true);
  PERFORM set_config('sql_safe_updates', 'off', true);

  v_r1 := public.recompute_padova_listings_contendibili();

  DELETE FROM public.padova_contendibili
  WHERE split_part(chiave_match, '|', 1) IN
        ('appartamento','appartamenti','annuncio','immobile','casa','villa','asta',
         'trilocale','bilocale','quadrilocale','monolocale','attico','mansarda',
         'loft','flat','room','terreno','ufficio','negozio')
     OR split_part(chiave_match, '|', 1) LIKE 'neighbourhood%';
  GET DIAGNOSTICS v_generic = ROW_COUNT;

  v_r2 := public.recompute_padova_contendibili_extras();

  SELECT count(*) INTO v_unmapped
  FROM public.padova_contendibili c
  WHERE c.quartiere IS NOT NULL AND btrim(c.quartiere) <> ''
    AND NOT EXISTS (
      SELECT 1 FROM public.quartiere_canon_map m
      WHERE m.chiave = public.canon_quartiere(c.quartiere)
    );

  UPDATE public.padova_contendibili c
     SET quartiere = m.microzona
    FROM public.quartiere_canon_map m
   WHERE public.canon_quartiere(c.quartiere) = m.chiave
     AND c.quartiere IS NOT NULL;

  UPDATE public.padova_contendibili
     SET quartiere = 'Altre zone'
   WHERE quartiere IS NULL OR btrim(quartiere) = '';

  RETURN jsonb_build_object(
    'ok', true,
    'clustering', v_r1,
    'extras', v_r2,
    'sanitized_bad_coords', COALESCE((v_r1->>'sanitized_bad_coords')::int, 0),
    'excluded_bad_title',   COALESCE((v_r1->>'excluded_bad_title')::int, 0),
    'excluded_generic_key', v_generic,
    'quartieri_non_mappati', v_unmapped
  );
END;
$function$;
