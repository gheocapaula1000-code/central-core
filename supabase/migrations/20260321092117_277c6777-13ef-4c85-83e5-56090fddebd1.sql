
-- Bridge jobs are accessed only by edge functions using service_role key.
-- No public/anon access needed. Policy allows service_role full access.
CREATE POLICY "service_role_full_access" ON public.listing_bridge_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
