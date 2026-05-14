-- 1) Roles infrastructure (standard Supabase RBAC pattern)
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- user_roles: only service_role manages writes; admins (and the user themselves) can read their roles.
CREATE POLICY "service_role full user_roles"
  ON public.user_roles FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "users read own roles"
  ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "admins read all roles"
  ON public.user_roles FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 2) Lock down microzona_dossier
ALTER TABLE public.microzona_dossier ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS by default, but we declare it explicitly for clarity.
CREATE POLICY "service_role full microzona_dossier"
  ON public.microzona_dossier FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Admin SELECT: only authenticated users with admin app role can read snapshots.
CREATE POLICY "admins read microzona_dossier"
  ON public.microzona_dossier FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Admin INSERT: only authenticated admins can append snapshots from the Core flow.
CREATE POLICY "admins insert microzona_dossier"
  ON public.microzona_dossier FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- No UPDATE / DELETE policies for authenticated/anon → append-only.
-- service_role retains full access for any maintenance.