DO $$
DECLARE
  v_key      text := 'stazione scrovegni c so del popolo fiera cittadella';
  v_count    integer;
  v_slug     text;
BEGIN
  -- Precondizione 1: esiste esattamente una riga con quella chiave.
  SELECT count(*) INTO v_count
  FROM public.civiko_quartiere_commercial_zone_map
  WHERE quartiere_key = v_key;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'ABORT: attesa esattamente 1 riga per %, trovate %', v_key, v_count;
  END IF;

  -- Precondizione 2: oggi punta a centro-storico.
  SELECT commercial_zone_slug INTO v_slug
  FROM public.civiko_quartiere_commercial_zone_map
  WHERE quartiere_key = v_key;

  IF v_slug IS DISTINCT FROM 'centro-storico' THEN
    RAISE EXCEPTION
      'ABORT: atteso commercial_zone_slug = centro-storico per %, trovato %',
      v_key, coalesce(v_slug, 'NULL');
  END IF;

  -- Azione: rimuove esclusivamente quella riga.
  DELETE FROM public.civiko_quartiere_commercial_zone_map
  WHERE quartiere_key = v_key;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'ABORT: delete ha rimosso % righe invece di 1', v_count;
  END IF;

  -- Postcondizione: le chiavi non ambigue restano intatte.
  SELECT count(*) INTO v_count
  FROM public.civiko_quartiere_commercial_zone_map
  WHERE quartiere_key IN ('stazione', 'stazione ferroviaria', 'scrovegni')
    AND commercial_zone_slug = 'centro-storico';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'ABORT: chiavi Stazione/Scrovegni non piu mappate a centro-storico';
  END IF;
END $$;