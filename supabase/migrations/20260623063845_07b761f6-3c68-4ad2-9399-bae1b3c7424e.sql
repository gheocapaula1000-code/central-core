
-- 1. SECURITY DEFINER view fix
ALTER VIEW public.total_spend_current_month SET (security_invoker = true);

-- 2. ai_spend_daily: admin-only SELECT
DROP POLICY IF EXISTS "authenticated read ai spend" ON public.ai_spend_daily;
CREATE POLICY "admin read ai spend" ON public.ai_spend_daily
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 3. apify_spend_daily
DROP POLICY IF EXISTS "authenticated read apify spend" ON public.apify_spend_daily;
CREATE POLICY "admin read apify spend" ON public.apify_spend_daily
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 4. firecrawl_spend_daily
DROP POLICY IF EXISTS "authenticated read firecrawl spend" ON public.firecrawl_spend_daily;
CREATE POLICY "admin read firecrawl spend" ON public.firecrawl_spend_daily
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 5. cron_alerts_pending
DROP POLICY IF EXISTS "authenticated read cron alerts" ON public.cron_alerts_pending;
CREATE POLICY "admin read cron alerts" ON public.cron_alerts_pending
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 6. operational_mode
DROP POLICY IF EXISTS "authenticated read operational mode" ON public.operational_mode;
CREATE POLICY "admin read operational mode" ON public.operational_mode
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 7. billing_customers: admin-only within agency
DROP POLICY IF EXISTS "agency_members_read_billing_customers" ON public.billing_customers;
CREATE POLICY "agency_admins_read_billing_customers" ON public.billing_customers
  FOR SELECT TO authenticated
  USING (public.is_agency_admin(agency_id));

-- 8. billing_entitlements: authenticated only
DROP POLICY IF EXISTS "public_read_entitlements" ON public.billing_entitlements;
CREATE POLICY "authenticated_read_entitlements" ON public.billing_entitlements
  FOR SELECT TO authenticated
  USING (true);

-- 9. padova_collect_v2_items: admin-only explicit SELECT policy
CREATE POLICY "admin read padova_collect_v2_items" ON public.padova_collect_v2_items
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
