
-- ============ agencies ============
CREATE TABLE IF NOT EXISTS public.agencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE,
  billing_email text,
  status text NOT NULL DEFAULT 'active',
  plan text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.agencies ENABLE ROW LEVEL SECURITY;

-- ============ agency_memberships ============
CREATE TABLE IF NOT EXISTS public.agency_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'agent' CHECK (role IN ('owner','admin','agent','viewer')),
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agency_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_agency_memberships_user ON public.agency_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_agency_memberships_agency ON public.agency_memberships(agency_id);
ALTER TABLE public.agency_memberships ENABLE ROW LEVEL SECURITY;

-- ============ helper functions ============
CREATE OR REPLACE FUNCTION public.is_agency_member(target_agency_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agency_memberships m
    WHERE m.agency_id = target_agency_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_agency_admin(target_agency_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agency_memberships m
    WHERE m.agency_id = target_agency_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
      AND m.role IN ('owner','admin')
  );
$$;

-- ============ agencies policies ============
DROP POLICY IF EXISTS service_role_full_agencies ON public.agencies;
CREATE POLICY service_role_full_agencies ON public.agencies
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS member_read_agencies ON public.agencies;
CREATE POLICY member_read_agencies ON public.agencies
  FOR SELECT TO authenticated USING (public.is_agency_member(id));
DROP POLICY IF EXISTS admin_update_agencies ON public.agencies;
CREATE POLICY admin_update_agencies ON public.agencies
  FOR UPDATE TO authenticated USING (public.is_agency_admin(id));

-- ============ memberships policies ============
DROP POLICY IF EXISTS service_role_full_memberships ON public.agency_memberships;
CREATE POLICY service_role_full_memberships ON public.agency_memberships
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS member_read_memberships ON public.agency_memberships;
CREATE POLICY member_read_memberships ON public.agency_memberships
  FOR SELECT TO authenticated USING (public.is_agency_member(agency_id));
DROP POLICY IF EXISTS admin_write_memberships ON public.agency_memberships;
CREATE POLICY admin_write_memberships ON public.agency_memberships
  FOR INSERT TO authenticated WITH CHECK (public.is_agency_admin(agency_id));
DROP POLICY IF EXISTS admin_update_memberships ON public.agency_memberships;
CREATE POLICY admin_update_memberships ON public.agency_memberships
  FOR UPDATE TO authenticated USING (public.is_agency_admin(agency_id));
DROP POLICY IF EXISTS admin_delete_memberships ON public.agency_memberships;
CREATE POLICY admin_delete_memberships ON public.agency_memberships
  FOR DELETE TO authenticated USING (public.is_agency_admin(agency_id));

-- ============ AOA: add columns ============
ALTER TABLE public.agency_operating_areas
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Replace permissive policies with member/admin gates (keep legacy user-only fallback)
DROP POLICY IF EXISTS user_read_own_aoa ON public.agency_operating_areas;
DROP POLICY IF EXISTS user_insert_own_aoa ON public.agency_operating_areas;
DROP POLICY IF EXISTS user_update_own_aoa ON public.agency_operating_areas;
DROP POLICY IF EXISTS user_delete_own_aoa ON public.agency_operating_areas;

CREATE POLICY aoa_select_member_or_self ON public.agency_operating_areas
  FOR SELECT TO authenticated
  USING (
    (agency_id IS NOT NULL AND public.is_agency_member(agency_id))
    OR (agency_id IS NULL AND user_id = auth.uid())
  );
CREATE POLICY aoa_insert_admin_or_self ON public.agency_operating_areas
  FOR INSERT TO authenticated
  WITH CHECK (
    (agency_id IS NOT NULL AND public.is_agency_admin(agency_id))
    OR (agency_id IS NULL AND user_id = auth.uid())
  );
CREATE POLICY aoa_update_admin_or_self ON public.agency_operating_areas
  FOR UPDATE TO authenticated
  USING (
    (agency_id IS NOT NULL AND public.is_agency_admin(agency_id))
    OR (agency_id IS NULL AND user_id = auth.uid())
  );

-- ============ ASP: add columns ============
ALTER TABLE public.agency_signal_preferences
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS operating_area_id uuid REFERENCES public.agency_operating_areas(id) ON DELETE SET NULL;

DROP POLICY IF EXISTS user_read_own_asp ON public.agency_signal_preferences;
DROP POLICY IF EXISTS user_insert_own_asp ON public.agency_signal_preferences;
DROP POLICY IF EXISTS user_update_own_asp ON public.agency_signal_preferences;
DROP POLICY IF EXISTS user_delete_own_asp ON public.agency_signal_preferences;

CREATE POLICY asp_select_member_or_self ON public.agency_signal_preferences
  FOR SELECT TO authenticated
  USING (
    (agency_id IS NOT NULL AND public.is_agency_member(agency_id))
    OR (agency_id IS NULL AND user_id = auth.uid())
  );
CREATE POLICY asp_insert_admin_or_self ON public.agency_signal_preferences
  FOR INSERT TO authenticated
  WITH CHECK (
    (agency_id IS NOT NULL AND public.is_agency_admin(agency_id))
    OR (agency_id IS NULL AND user_id = auth.uid())
  );
CREATE POLICY asp_update_admin_or_self ON public.agency_signal_preferences
  FOR UPDATE TO authenticated
  USING (
    (agency_id IS NOT NULL AND public.is_agency_admin(agency_id))
    OR (agency_id IS NULL AND user_id = auth.uid())
  );

-- timestamp triggers
DROP TRIGGER IF EXISTS trg_agencies_updated ON public.agencies;
CREATE TRIGGER trg_agencies_updated BEFORE UPDATE ON public.agencies
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();
DROP TRIGGER IF EXISTS trg_agency_memberships_updated ON public.agency_memberships;
CREATE TRIGGER trg_agency_memberships_updated BEFORE UPDATE ON public.agency_memberships
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();
