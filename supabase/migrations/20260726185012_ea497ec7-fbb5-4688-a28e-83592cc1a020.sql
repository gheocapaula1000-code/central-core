
CREATE OR REPLACE FUNCTION public.vault_ccjs_status()
RETURNS TABLE(name text, len int)
LANGUAGE sql SECURITY DEFINER SET search_path = public, vault
AS $$
  SELECT s.name, length(ds.decrypted_secret)
  FROM vault.secrets s
  JOIN vault.decrypted_secrets ds ON ds.id = s.id
  WHERE lower(s.name) = lower('CENTRAL_CORE_JOB_SECRET');
$$;
REVOKE ALL ON FUNCTION public.vault_ccjs_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vault_ccjs_status() TO service_role;

CREATE OR REPLACE FUNCTION public.vault_ccjs_sync(p_value text)
RETURNS TABLE(name text, len int, action text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault
AS $$
DECLARE
  r record;
  v_action text := 'noop';
  v_canonical text := 'CENTRAL_CORE_JOB_SECRET';
  v_exact_id uuid;
BEGIN
  -- Verifica esistenza riga esatta
  SELECT s.id INTO v_exact_id FROM vault.secrets s WHERE s.name = v_canonical;

  IF v_exact_id IS NULL THEN
    -- Cerca varianti case-insensitive
    FOR r IN
      SELECT s.id, s.name FROM vault.secrets s
      WHERE lower(s.name) = lower(v_canonical)
    LOOP
      -- Rinomina la variante al nome canonico e aggiorna valore
      PERFORM vault.update_secret(r.id, p_value, v_canonical);
      v_action := 'renamed_and_updated';
      v_exact_id := r.id;
      EXIT;
    END LOOP;
  END IF;

  IF v_exact_id IS NULL THEN
    PERFORM vault.create_secret(p_value, v_canonical);
    v_action := 'created';
  ELSIF v_action = 'noop' THEN
    -- Confronta valore attuale
    IF EXISTS (
      SELECT 1 FROM vault.decrypted_secrets ds
      WHERE ds.id = v_exact_id AND ds.decrypted_secret = p_value
    ) THEN
      v_action := 'unchanged';
    ELSE
      PERFORM vault.update_secret(v_exact_id, p_value);
      v_action := 'updated';
    END IF;
  END IF;

  RETURN QUERY
    SELECT s.name, length(ds.decrypted_secret), v_action
    FROM vault.secrets s
    JOIN vault.decrypted_secrets ds ON ds.id = s.id
    WHERE lower(s.name) = lower(v_canonical);
END;
$$;
REVOKE ALL ON FUNCTION public.vault_ccjs_sync(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vault_ccjs_sync(text) TO service_role;
