-- TrovaBandi runtime hardening — additivo e isolato al dominio trovabandi_*.
-- Nessuno scheduler, nessuna modifica ad altri domini, nessun dato alterato.

-- Selezione equa delle fonti dovute (enabled, ordinate per next_scan_at).
CREATE INDEX IF NOT EXISTS trovabandi_sources_due_idx
  ON public.trovabandi_sources (next_scan_at ASC, last_scanned_at ASC NULLS FIRST, priority DESC)
  WHERE enabled = true;

CREATE INDEX IF NOT EXISTS trovabandi_sources_enabled_kind_idx
  ON public.trovabandi_sources (source_kind)
  WHERE enabled = true;

-- Riconciliazione dei run appesi: solo i RUNNING sono interessanti.
CREATE INDEX IF NOT EXISTS trovabandi_runs_running_idx
  ON public.trovabandi_runs (started_at)
  WHERE status = 'RUNNING';

-- Copertura del gate: run conclusi con esito SUCCEEDED per fonte.
CREATE INDEX IF NOT EXISTS trovabandi_runs_succeeded_coverage_idx
  ON public.trovabandi_runs (finished_at DESC, source_id)
  WHERE status = 'SUCCEEDED' AND source_id IS NOT NULL;

-- Conteggio DISTINCT degli opportunity VERIFICATO/ufficiali/non scaduti che
-- possiedono almeno una prova: EXISTS, mai un join che duplica le righe.
CREATE OR REPLACE FUNCTION public.trovabandi_verified_active_distinct_count(
  p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT count(*)::int
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