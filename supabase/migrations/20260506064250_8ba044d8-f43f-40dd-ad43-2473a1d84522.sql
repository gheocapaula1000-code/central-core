
-- agency_operating_areas
CREATE TABLE IF NOT EXISTS public.agency_operating_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  agency_id uuid,
  workspace_id uuid,
  label text,
  province text[] NOT NULL DEFAULT '{}',
  comuni text[] NOT NULL DEFAULT '{}',
  microzones text[] NOT NULL DEFAULT '{}',
  quartieri text[] NOT NULL DEFAULT '{}',
  focus text[] NOT NULL DEFAULT '{}',
  radius_km numeric,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.agency_operating_areas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_read_own_aoa" ON public.agency_operating_areas
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR agency_id = auth.uid());
CREATE POLICY "user_insert_own_aoa" ON public.agency_operating_areas
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid() OR agency_id = auth.uid());
CREATE POLICY "user_update_own_aoa" ON public.agency_operating_areas
  FOR UPDATE TO authenticated USING (user_id = auth.uid() OR agency_id = auth.uid());
CREATE POLICY "user_delete_own_aoa" ON public.agency_operating_areas
  FOR DELETE TO authenticated USING (user_id = auth.uid() OR agency_id = auth.uid());
CREATE POLICY "service_role_full_aoa" ON public.agency_operating_areas
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_aoa_user ON public.agency_operating_areas(user_id);
CREATE INDEX IF NOT EXISTS idx_aoa_agency ON public.agency_operating_areas(agency_id);

-- agency_signal_preferences
CREATE TABLE IF NOT EXISTS public.agency_signal_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  agency_id uuid,
  workspace_id uuid,
  include_signal_types text[] NOT NULL DEFAULT '{}',
  exclude_signal_types text[] NOT NULL DEFAULT '{}',
  min_confidence numeric NOT NULL DEFAULT 0.55,
  exclude_auctions boolean NOT NULL DEFAULT true,
  include_public_alienations boolean NOT NULL DEFAULT false,
  include_urban_planning boolean NOT NULL DEFAULT true,
  include_mobility boolean NOT NULL DEFAULT true,
  include_services boolean NOT NULL DEFAULT true,
  include_green_risk_sentiment boolean NOT NULL DEFAULT true,
  include_tourism boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.agency_signal_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_read_own_asp" ON public.agency_signal_preferences
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR agency_id = auth.uid());
CREATE POLICY "user_insert_own_asp" ON public.agency_signal_preferences
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid() OR agency_id = auth.uid());
CREATE POLICY "user_update_own_asp" ON public.agency_signal_preferences
  FOR UPDATE TO authenticated USING (user_id = auth.uid() OR agency_id = auth.uid());
CREATE POLICY "user_delete_own_asp" ON public.agency_signal_preferences
  FOR DELETE TO authenticated USING (user_id = auth.uid() OR agency_id = auth.uid());
CREATE POLICY "service_role_full_asp" ON public.agency_signal_preferences
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_asp_user ON public.agency_signal_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_asp_agency ON public.agency_signal_preferences(agency_id);

-- Freeze nominative obituary sources (no delete)
UPDATE public.obituaries_sources SET is_active = false WHERE is_active = true;
