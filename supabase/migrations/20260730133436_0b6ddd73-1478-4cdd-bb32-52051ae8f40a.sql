CREATE TABLE IF NOT EXISTS public.civiko_admin_workspaces (
  workspace_id uuid PRIMARY KEY,
  active boolean NOT NULL DEFAULT true,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.civiko_admin_workspaces FROM anon;
REVOKE ALL ON public.civiko_admin_workspaces FROM authenticated;
REVOKE ALL ON public.civiko_admin_workspaces FROM PUBLIC;
GRANT ALL ON public.civiko_admin_workspaces TO service_role;

ALTER TABLE public.civiko_admin_workspaces ENABLE ROW LEVEL SECURITY;

INSERT INTO public.civiko_admin_workspaces (workspace_id, active, label)
VALUES ('cacf7479-cf55-437c-8c39-7c11481391ac', true, 'platform_owner')
ON CONFLICT (workspace_id) DO UPDATE
  SET active = true, label = 'platform_owner', updated_at = now();

CREATE OR REPLACE FUNCTION public.civiko_is_admin_agency(_agency_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.civiko_admin_workspaces w
    WHERE w.workspace_id = _agency_id AND w.active
  ) OR EXISTS (
    SELECT 1
    FROM public.agency_memberships am
    JOIN public.user_roles ur
      ON ur.user_id = am.user_id
     AND ur.role = 'admin'
    WHERE am.agency_id = _agency_id
  );
$$;