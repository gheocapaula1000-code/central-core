
-- 1. civiko_source_ingestion_runs: restrict SELECT to admins
DROP POLICY IF EXISTS "ingestion_runs authenticated read" ON public.civiko_source_ingestion_runs;
CREATE POLICY "ingestion_runs admin read"
  ON public.civiko_source_ingestion_runs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 2. obituaries_sources: remove public read, admin-only
DROP POLICY IF EXISTS "public_read_active_obs" ON public.obituaries_sources;
CREATE POLICY "obituaries_sources admin read"
  ON public.obituaries_sources
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 3. radar_signals: fix confused-deputy agency_id = auth.uid() check
DROP POLICY IF EXISTS "agency_read_own_rs" ON public.radar_signals;
CREATE POLICY "agency_read_own_rs"
  ON public.radar_signals
  FOR SELECT TO authenticated
  USING (public.is_agency_member(agency_id));

-- 4. succession_heatmap_cap: explicit admin read policy
CREATE POLICY "succession_heatmap_cap admin read"
  ON public.succession_heatmap_cap
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
