-- 1) Backup tables: revoke public/anon/authenticated access, enable RLS (deny-all, no policies)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    '_bkp_20260724020000_cont',
    '_bkp_20260724020000_cont_ids',
    '_bkp_20260724020000_mp',
    '_bkp_20260724020000_mp_ids',
    '_bkp_20260724_eosc_touched',
    '_bkp_20260724_padova_contendibili',
    '_bkp_20260724_padova_multi_portale',
    '_bkp_20260808_zone_contract_v2'
  ] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- 2) Views: enforce querying user's permissions/RLS instead of the view owner's
ALTER VIEW public.civiko_padova_release_gate_v SET (security_invoker = true);
ALTER VIEW public.early_offmarket_signal_candidates_by_zone_v SET (security_invoker = true);
ALTER VIEW public.padova_cambi_agenzia_by_zone_v SET (security_invoker = true);
ALTER VIEW public.padova_collect_v2_items_by_zone_v SET (security_invoker = true);
ALTER VIEW public.padova_contendibili_by_zone_v SET (security_invoker = true);
ALTER VIEW public.padova_listings_zone_v SET (security_invoker = true);
ALTER VIEW public.padova_multi_portale_by_zone_v SET (security_invoker = true);
ALTER VIEW public.padova_quartieri_stats_v SET (security_invoker = true);
ALTER VIEW public.padova_totali_v SET (security_invoker = true);

-- 3) Fix mutable search_path on the remaining function
ALTER FUNCTION public.civiko_ascii_fold(text) SET search_path = public;