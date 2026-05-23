
-- 1. Fix wrong agency_id = auth.uid() policies
DROP POLICY IF EXISTS "agency_read_own_outcomes" ON public.agency_property_outcomes;
CREATE POLICY "agency_members_read_outcomes" ON public.agency_property_outcomes
  FOR SELECT TO authenticated USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS "agency_read_own_customer" ON public.billing_customers;
CREATE POLICY "agency_members_read_billing_customers" ON public.billing_customers
  FOR SELECT TO authenticated USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS "agency_read_own_subscription" ON public.billing_subscriptions;
CREATE POLICY "agency_members_read_billing_subs" ON public.billing_subscriptions
  FOR SELECT TO authenticated USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS "agency_read_own_usage" ON public.billing_usage;
CREATE POLICY "agency_members_read_billing_usage" ON public.billing_usage
  FOR SELECT TO authenticated USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS "agency_read_own_objections" ON public.owner_objection_patterns;
CREATE POLICY "agency_members_read_objections" ON public.owner_objection_patterns
  FOR SELECT TO authenticated USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS "agency_read_own_rrl" ON public.radar_run_log;
CREATE POLICY "agency_members_read_rrl" ON public.radar_run_log
  FOR SELECT TO authenticated USING (public.is_agency_member(agency_id));

-- 2. Remove public read of internal infra; restrict to admins
DROP POLICY IF EXISTS "public_read_crawl_watchlist" ON public.crawl_watchlist;
CREATE POLICY "admin_read_crawl_watchlist" ON public.crawl_watchlist
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "public_read_data_sources" ON public.data_sources;
CREATE POLICY "admin_read_data_sources" ON public.data_sources
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "public_read_omi_import_jobs" ON public.omi_import_jobs;
CREATE POLICY "admin_read_omi_import_jobs" ON public.omi_import_jobs
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "public_read_omi_import_log" ON public.omi_import_log;
CREATE POLICY "admin_read_omi_import_log" ON public.omi_import_log
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- 3. Remove public read of sensitive agency-private intelligence
DROP POLICY IF EXISTS "public_read_etz" ON public.estate_turnover_zones;
CREATE POLICY "admin_read_etz" ON public.estate_turnover_zones
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "public_read_ips" ON public.inheritance_pressure_signals;
CREATE POLICY "admin_read_ips" ON public.inheritance_pressure_signals
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- 4. Storage: admin-only access on csv-imports bucket
CREATE POLICY "csv_imports_admin_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'csv-imports' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "csv_imports_admin_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'csv-imports' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "csv_imports_admin_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'csv-imports' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "csv_imports_admin_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'csv-imports' AND public.has_role(auth.uid(), 'admin'));

-- 5. Lock down SECURITY DEFINER functions not meant for public/authenticated callers
REVOKE EXECUTE ON FUNCTION public.clear_omi_geometry() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.insert_omi_geometry(text,text,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.property_registry_upsert(text,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.property_registry_lookup(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vault_create_secret_if_missing(text,text) FROM PUBLIC, anon, authenticated;

-- 6. Set fixed search_path on trigger functions
ALTER FUNCTION public.obituaries_seen_locked() SET search_path = public;
ALTER FUNCTION public.obituaries_sources_locked() SET search_path = public;
