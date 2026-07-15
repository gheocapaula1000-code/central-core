
-- 1) RLS on lookup tables
ALTER TABLE public.quartiere_zona_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "quartiere_zona_map public read" ON public.quartiere_zona_map FOR SELECT USING (true);
CREATE POLICY "quartiere_zona_map service write" ON public.quartiere_zona_map FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.quartiere_canon_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "quartiere_canon_map public read" ON public.quartiere_canon_map FOR SELECT USING (true);
CREATE POLICY "quartiere_canon_map service write" ON public.quartiere_canon_map FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2) luxu_assets: remove anon read, restrict to admins
DROP POLICY IF EXISTS "anon can read active assets" ON public.luxu_assets;
CREATE POLICY "luxu_assets admin read" ON public.luxu_assets FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 3) Recreate view with security_invoker
ALTER VIEW public.radar_budget_monthly_spend SET (security_invoker = true);

-- 4) Fix mutable search_path
ALTER FUNCTION public.norm_agency_name(text) SET search_path = public;
