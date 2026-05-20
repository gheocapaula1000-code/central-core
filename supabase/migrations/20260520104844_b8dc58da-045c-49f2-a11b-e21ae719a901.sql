CREATE OR REPLACE FUNCTION public.vault_create_secret_if_missing(p_name text, p_value text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $$
DECLARE
  v_existing uuid;
  v_new      uuid;
BEGIN
  SELECT id INTO v_existing FROM vault.secrets WHERE name = p_name LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('existed', true, 'id', v_existing::text);
  END IF;
  v_new := vault.create_secret(p_value, p_name);
  RETURN jsonb_build_object('existed', false, 'id', v_new::text);
END;
$$;

REVOKE ALL ON FUNCTION public.vault_create_secret_if_missing(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vault_create_secret_if_missing(text, text) TO service_role;