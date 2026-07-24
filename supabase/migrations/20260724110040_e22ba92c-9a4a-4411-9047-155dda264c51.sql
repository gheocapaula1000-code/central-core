CREATE OR REPLACE FUNCTION public.vault_secret_exists(p_name text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public','vault'
AS $$
  SELECT EXISTS (SELECT 1 FROM vault.secrets WHERE name = p_name);
$$;
REVOKE ALL ON FUNCTION public.vault_secret_exists(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vault_secret_exists(text) TO service_role, postgres;