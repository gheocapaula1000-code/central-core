-- TrovaBandi — conteggio distinto verificato: ritorno bigint (nessun rischio di
-- troncamento) e search_path esplicito. Additivo, isolato al dominio trovabandi_*.
DROP FUNCTION IF EXISTS public.trovabandi_verified_active_distinct_count(timestamptz);

CREATE FUNCTION public.trovabandi_verified_active_distinct_count(
  p_now timestamptz DEFAULT now()
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT count(*)::bigint
    FROM public.trovabandi_opportunities o
   WHERE o.verification_status = 'VERIFICATO'
     AND o.official_source = true
     AND (o.deadline_at IS NULL OR o.deadline_at >= p_now)
     AND EXISTS (
       SELECT 1
         FROM public.trovabandi_evidence e
        WHERE e.opportunity_id = o.id
     );
$function$;

REVOKE ALL ON FUNCTION public.trovabandi_verified_active_distinct_count(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trovabandi_verified_active_distinct_count(timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.trovabandi_verified_active_distinct_count(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.trovabandi_verified_active_distinct_count(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.trovabandi_verified_active_distinct_count(timestamptz) TO postgres;