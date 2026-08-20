REVOKE ALL ON FUNCTION public.recompute_padova_contendibili_photo_v5() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recompute_padova_contendibili() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_padova_contendibili_photo_v5() TO service_role;
GRANT EXECUTE ON FUNCTION public.recompute_padova_contendibili() TO service_role;