create or replace function public.trovabandi_diag_invoke(p_source_id uuid, p_max_pages int default 2)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_secret text;
  v_request_id bigint;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'AI_CORE_SECRET_TROVABANDI' limit 1;
  if v_secret is null then
    raise exception 'TROVABANDI_SECRET_MISSING';
  end if;
  select net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/trovabandi-engine',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('action','collect','source_id',p_source_id,'max_pages',p_max_pages,'trigger_source','diagnostic'),
    timeout_milliseconds := 170000
  ) into v_request_id;
  return v_request_id;
end;
$$;
revoke all on function public.trovabandi_diag_invoke(uuid, int) from public, anon, authenticated;