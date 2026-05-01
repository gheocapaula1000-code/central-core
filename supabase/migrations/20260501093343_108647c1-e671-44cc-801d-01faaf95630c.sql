-- 1. Add monthly_radar limit column to entitlements
ALTER TABLE public.billing_entitlements
  ADD COLUMN IF NOT EXISTS monthly_radar integer;

-- 2. Add radar_used usage counter to usage table
ALTER TABLE public.billing_usage
  ADD COLUMN IF NOT EXISTS radar_used integer NOT NULL DEFAULT 0;

-- 3. Ensure unique constraint exists for upsert on (plan_key, app_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_entitlements_plan_app_unique'
  ) THEN
    ALTER TABLE public.billing_entitlements
      ADD CONSTRAINT billing_entitlements_plan_app_unique
      UNIQUE (plan_key, app_id);
  END IF;
END $$;

-- 4. Upsert plan limits (do not overwrite other fields)
INSERT INTO public.billing_entitlements
  (plan_key, app_id, monthly_scans, monthly_radar, team_seats)
VALUES
  ('civiko_studio', 'civiko_one', 30,   10,   1),
  ('civiko_pro',    'civiko_one', 100,  50,   3),
  ('civiko_elite',  'civiko_one', NULL, NULL, 10)
ON CONFLICT (plan_key, app_id) DO UPDATE SET
  monthly_scans = EXCLUDED.monthly_scans,
  monthly_radar = EXCLUDED.monthly_radar,
  team_seats    = EXCLUDED.team_seats,
  updated_at    = now();