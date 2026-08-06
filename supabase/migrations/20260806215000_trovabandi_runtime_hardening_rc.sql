-- TrovaBandi-only forward repair after applied migrations 20260806181739 and
-- 20260806193420. No shared product object, data row or scheduler is touched.

CREATE INDEX IF NOT EXISTS trovabandi_sources_fair_due_rc_idx
  ON public.trovabandi_sources
    (next_scan_at ASC, last_scanned_at ASC NULLS FIRST, priority DESC, id ASC)
  WHERE enabled = true;

CREATE INDEX IF NOT EXISTS trovabandi_runs_recent_success_rc_idx
  ON public.trovabandi_runs (finished_at DESC, source_id)
  WHERE status = 'SUCCEEDED' AND finished_at IS NOT NULL AND source_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.trovabandi_verified_active_distinct_count(p_now timestamptz)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(DISTINCT opportunity.id)::bigint
  FROM public.trovabandi_opportunities AS opportunity
  WHERE opportunity.verification_status = 'VERIFICATO'
    AND opportunity.official_source = true
    AND opportunity.last_verified_at IS NOT NULL
    AND (opportunity.deadline_at IS NULL OR opportunity.deadline_at >= p_now)
    AND EXISTS (
      SELECT 1
      FROM public.trovabandi_evidence AS evidence
      WHERE evidence.opportunity_id = opportunity.id
    );
$$;

REVOKE ALL ON FUNCTION public.trovabandi_verified_active_distinct_count(timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trovabandi_verified_active_distinct_count(timestamptz)
  TO service_role, postgres;

-- Lovable Cloud can leave an explicit per-project sandbox executor grant even
-- after PUBLIC is revoked. Remove only that connector role on this TB-only RPC.
DO $$
DECLARE
  sandbox_role record;
BEGIN
  FOR sandbox_role IN
    SELECT rolname
    FROM pg_roles
    WHERE rolname LIKE 'sandbox_exec_%'
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.trovabandi_verified_active_distinct_count(timestamptz) FROM %I',
      sandbox_role.rolname
    );
  END LOOP;
END;
$$;
