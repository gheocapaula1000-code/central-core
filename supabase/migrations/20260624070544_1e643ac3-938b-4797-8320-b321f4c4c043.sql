
-- =====================================================
-- CIVIKO ONE REBUILD — V1 SCHEMA
-- Multi-tenant via agencies + agency_memberships
-- =====================================================

-- Enums
DO $$ BEGIN
  CREATE TYPE public.civiko_one_case_status AS ENUM (
    'draft','active','listed','negotiating','sold','withdrawn','archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.civiko_one_doc_status AS ENUM (
    'missing','uploaded','verified','rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.civiko_one_output_kind AS ENUM (
    'owner_dossier','listing_casa','listing_immobiliare','listing_idealista','listing_subito','promo_plan'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================
-- 1) property_cases
-- =====================================================
CREATE TABLE public.civiko_one_property_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  created_by uuid NOT NULL,
  assigned_agent_id uuid,
  title text NOT NULL,
  status public.civiko_one_case_status NOT NULL DEFAULT 'draft',
  address_text text,
  civico text,
  cap text,
  municipality text,
  province text,
  microzone text,
  lat double precision,
  lng double precision,
  property_type text,
  rooms integer,
  bathrooms integer,
  surface_mq numeric,
  floor text,
  energy_class text,
  year_built integer,
  ask_price numeric,
  draft_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.civiko_one_property_cases TO authenticated;
GRANT ALL ON public.civiko_one_property_cases TO service_role;

ALTER TABLE public.civiko_one_property_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "co_cases_select_members"
  ON public.civiko_one_property_cases FOR SELECT TO authenticated
  USING (public.is_agency_member(agency_id));

CREATE POLICY "co_cases_insert_members"
  ON public.civiko_one_property_cases FOR INSERT TO authenticated
  WITH CHECK (public.is_agency_member(agency_id) AND created_by = auth.uid());

CREATE POLICY "co_cases_update_members"
  ON public.civiko_one_property_cases FOR UPDATE TO authenticated
  USING (public.is_agency_member(agency_id))
  WITH CHECK (public.is_agency_member(agency_id));

CREATE POLICY "co_cases_delete_admins"
  ON public.civiko_one_property_cases FOR DELETE TO authenticated
  USING (public.is_agency_admin(agency_id));

CREATE INDEX idx_co_cases_agency ON public.civiko_one_property_cases(agency_id, status, updated_at DESC);
CREATE INDEX idx_co_cases_agent ON public.civiko_one_property_cases(assigned_agent_id);

CREATE TRIGGER trg_co_cases_updated
  BEFORE UPDATE ON public.civiko_one_property_cases
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();

-- =====================================================
-- 2) property_photos
-- =====================================================
CREATE TABLE public.civiko_one_property_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.civiko_one_property_cases(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  uploaded_by uuid NOT NULL,
  storage_path text NOT NULL,
  caption text,
  sort_order integer NOT NULL DEFAULT 0,
  is_cover boolean NOT NULL DEFAULT false,
  width integer,
  height integer,
  bytes integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.civiko_one_property_photos TO authenticated;
GRANT ALL ON public.civiko_one_property_photos TO service_role;

ALTER TABLE public.civiko_one_property_photos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "co_photos_select_members"
  ON public.civiko_one_property_photos FOR SELECT TO authenticated
  USING (public.is_agency_member(agency_id));

CREATE POLICY "co_photos_insert_members"
  ON public.civiko_one_property_photos FOR INSERT TO authenticated
  WITH CHECK (public.is_agency_member(agency_id) AND uploaded_by = auth.uid());

CREATE POLICY "co_photos_update_members"
  ON public.civiko_one_property_photos FOR UPDATE TO authenticated
  USING (public.is_agency_member(agency_id))
  WITH CHECK (public.is_agency_member(agency_id));

CREATE POLICY "co_photos_delete_members"
  ON public.civiko_one_property_photos FOR DELETE TO authenticated
  USING (public.is_agency_member(agency_id));

CREATE INDEX idx_co_photos_case ON public.civiko_one_property_photos(case_id, sort_order);

-- =====================================================
-- 3) property_documents
-- =====================================================
CREATE TABLE public.civiko_one_property_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.civiko_one_property_cases(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  uploaded_by uuid,
  doc_type text NOT NULL,
  display_name text NOT NULL,
  storage_path text,
  status public.civiko_one_doc_status NOT NULL DEFAULT 'missing',
  required boolean NOT NULL DEFAULT false,
  notes text,
  verified_by uuid,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.civiko_one_property_documents TO authenticated;
GRANT ALL ON public.civiko_one_property_documents TO service_role;

ALTER TABLE public.civiko_one_property_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "co_docs_select_members"
  ON public.civiko_one_property_documents FOR SELECT TO authenticated
  USING (public.is_agency_member(agency_id));

CREATE POLICY "co_docs_insert_members"
  ON public.civiko_one_property_documents FOR INSERT TO authenticated
  WITH CHECK (public.is_agency_member(agency_id));

CREATE POLICY "co_docs_update_members"
  ON public.civiko_one_property_documents FOR UPDATE TO authenticated
  USING (public.is_agency_member(agency_id))
  WITH CHECK (public.is_agency_member(agency_id));

CREATE POLICY "co_docs_delete_admins"
  ON public.civiko_one_property_documents FOR DELETE TO authenticated
  USING (public.is_agency_admin(agency_id));

CREATE INDEX idx_co_docs_case ON public.civiko_one_property_documents(case_id, doc_type);

CREATE TRIGGER trg_co_docs_updated
  BEFORE UPDATE ON public.civiko_one_property_documents
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();

-- =====================================================
-- 4) generated_outputs
-- =====================================================
CREATE TABLE public.civiko_one_generated_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.civiko_one_property_cases(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  generated_by uuid,
  kind public.civiko_one_output_kind NOT NULL,
  version integer NOT NULL DEFAULT 1,
  content_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  storage_path text,
  model_used text,
  cost_eur numeric,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.civiko_one_generated_outputs TO authenticated;
GRANT ALL ON public.civiko_one_generated_outputs TO service_role;

ALTER TABLE public.civiko_one_generated_outputs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "co_outputs_select_members"
  ON public.civiko_one_generated_outputs FOR SELECT TO authenticated
  USING (public.is_agency_member(agency_id));

CREATE POLICY "co_outputs_insert_members"
  ON public.civiko_one_generated_outputs FOR INSERT TO authenticated
  WITH CHECK (public.is_agency_member(agency_id));

CREATE POLICY "co_outputs_delete_admins"
  ON public.civiko_one_generated_outputs FOR DELETE TO authenticated
  USING (public.is_agency_admin(agency_id));

CREATE INDEX idx_co_outputs_case ON public.civiko_one_generated_outputs(case_id, kind, version DESC);
