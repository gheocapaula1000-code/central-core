-- ═══════════════════════════════════════════════════════════════
-- Padova Zone Radar — coda per processing zona-per-zona
-- Evita mega-run fragili: ogni zona è atomica e idempotente.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.padova_zone_radar_queue (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL,
  municipality TEXT NOT NULL DEFAULT 'Padova',
  province TEXT NOT NULL DEFAULT 'PD',
  zone_name TEXT NOT NULL,
  zone_type TEXT,
  omi_zone_id TEXT,
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  last_error TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT padova_zone_radar_queue_status_chk
    CHECK (status IN ('pending','running','completed','partial','failed','skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS padova_zone_radar_queue_run_zone_uq
  ON public.padova_zone_radar_queue (run_id, zone_name);
CREATE INDEX IF NOT EXISTS padova_zone_radar_queue_run_status_idx
  ON public.padova_zone_radar_queue (run_id, status);
CREATE INDEX IF NOT EXISTS padova_zone_radar_queue_status_idx
  ON public.padova_zone_radar_queue (status);

ALTER TABLE public.padova_zone_radar_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_padova_zone_radar_queue" ON public.padova_zone_radar_queue;
CREATE POLICY "service_role_full_padova_zone_radar_queue"
  ON public.padova_zone_radar_queue
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS padova_zone_radar_queue_touch ON public.padova_zone_radar_queue;
CREATE TRIGGER padova_zone_radar_queue_touch
BEFORE UPDATE ON public.padova_zone_radar_queue
FOR EACH ROW
EXECUTE FUNCTION public.civiko_touch_updated_at();