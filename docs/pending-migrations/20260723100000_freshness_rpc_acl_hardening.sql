-- ============================================================================
-- Central Core — Hardening ACL RPC freshness
-- ----------------------------------------------------------------------------
-- Scopo: impedire a PUBLIC, anon e authenticated di eseguire direttamente
--        le RPC di freshness. EXECUTE consentito solo a service_role.
--
-- Chiamanti runtime autorizzati (tutti server-side con SERVICE_ROLE_KEY):
--   - supabase/functions/padova-apify-collect-pending/index.ts
--   - supabase/functions/padova-agencies-pipeline/index.ts
--   - supabase/functions/civiko-radar-veneto/ribassiPortali.ts
--
-- NON modifica: corpi, firme, owner, SECURITY DEFINER, search_path.
-- NON revoca privilegi al proprietario postgres.
-- NON tocca il ruolo sandbox_exec (privilegio storicamente concesso da
-- postgres; da valutare separatamente una volta identificata con certezza
-- la sua funzione operativa).
-- Nessun DML, nessun backfill.
-- ============================================================================

BEGIN;

REVOKE ALL ON FUNCTION public.expire_padova_agency_listings(timestamptz)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.promote_padova_collect_v2_to_listings(timestamptz)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.expire_padova_agency_listings(timestamptz)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.promote_padova_collect_v2_to_listings(timestamptz)
  TO service_role;

COMMIT;
