DO $mig$
DECLARE
  csc_before bigint;
  psm_before bigint;
  csc_after  bigint;
  psm_after  bigint;
  psm_signal_type text;
  fk_name text;
BEGIN
  SELECT count(*) INTO csc_before FROM public.civiko_signals_classified;
  SELECT count(*) INTO psm_before FROM public.property_signal_matches;
  RAISE NOTICE '[PRE] civiko_signals_classified=%, property_signal_matches=%', csc_before, psm_before;

  -- Drop any FK on property_signal_matches.signal_id (points to wrong column, blocks type change)
  FOR fk_name IN
    SELECT conname FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname='public' AND t.relname='property_signal_matches' AND c.contype='f'
      AND EXISTS (
        SELECT 1 FROM unnest(c.conkey) k
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k
        WHERE a.attname='signal_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.property_signal_matches DROP CONSTRAINT %I', fk_name);
    RAISE NOTICE '[FK] dropped %', fk_name;
  END LOOP;

  -- C2: bigint -> text
  SELECT data_type INTO psm_signal_type
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='property_signal_matches' AND column_name='signal_id';

  IF psm_signal_type = 'bigint' THEN
    ALTER TABLE public.property_signal_matches
      ALTER COLUMN signal_id TYPE text USING signal_id::text;
    RAISE NOTICE '[C2] property_signal_matches.signal_id: bigint -> text';
  ELSE
    RAISE NOTICE '[C2] property_signal_matches.signal_id already %, skip', psm_signal_type;
  END IF;

  EXECUTE 'DROP INDEX IF EXISTS public.idx_psm_signal';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_psm_signal ON public.property_signal_matches(signal_id)';
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS ux_psm_property_signal ON public.property_signal_matches(property_id, signal_id)';

  -- C4
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_csc_usable ON public.civiko_signals_classified(usable_for_scoring) WHERE usable_for_scoring = true';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_csc_source_name ON public.civiko_signals_classified(source_name_internal)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_psm_prop_rel ON public.property_signal_matches(property_id, relevance_score DESC)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_padova_listings_zone_active ON public.padova_listings(commercial_zone_slug) WHERE expired_at IS NULL';

  SELECT count(*) INTO csc_after FROM public.civiko_signals_classified;
  SELECT count(*) INTO psm_after FROM public.property_signal_matches;
  RAISE NOTICE '[POST] civiko_signals_classified=%, property_signal_matches=%', csc_after, psm_after;

  IF csc_after <> csc_before OR psm_after <> psm_before THEN
    RAISE EXCEPTION 'Row count changed! csc %->%, psm %->%', csc_before, csc_after, psm_before, psm_after;
  END IF;

  RAISE NOTICE '[OK] Zero righe perse.';
END
$mig$;