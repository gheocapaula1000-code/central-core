DO $do$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'recompute_padova_listings_contendibili';

  src := replace(src,
    'COALESCE(p.ev_agency_key, public.norm_agency(p.agency)) AS agency_n_full',
    'public.norm_agency(p.agency) AS agency_n_full');

  EXECUTE 'CREATE OR REPLACE FUNCTION public.recompute_padova_listings_contendibili() '
       || 'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS '
       || '$civiko_rc_20260810b$' || src || '$civiko_rc_20260810b$';
END $do$;