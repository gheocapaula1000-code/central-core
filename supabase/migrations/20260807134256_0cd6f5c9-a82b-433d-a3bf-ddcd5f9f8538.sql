-- Civiko One commissioning — additive, isolated. No existing object is altered.

CREATE TABLE IF NOT EXISTS public.civiko_commissioning_baselines (
  snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at timestamptz NOT NULL DEFAULT now(),
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  complete boolean NOT NULL DEFAULT false,
  failed_queries jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.civiko_commissioning_baselines TO service_role;
ALTER TABLE public.civiko_commissioning_baselines ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.civiko_commissioning_runs (
  run_id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('apify','firecrawl','perplexity','chain')),
  action text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','BLOCKED','FAILED')),
  requested_cap jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_cap jsonb,
  cap_confirmed boolean NOT NULL DEFAULT false,
  baseline_snapshot_id uuid REFERENCES public.civiko_commissioning_baselines(snapshot_id) ON DELETE SET NULL,
  actual_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS civiko_commissioning_runs_started_idx
  ON public.civiko_commissioning_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS civiko_commissioning_runs_provider_idx
  ON public.civiko_commissioning_runs (provider, started_at DESC);
GRANT ALL ON public.civiko_commissioning_runs TO service_role;
ALTER TABLE public.civiko_commissioning_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.civiko_commissioning_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.civiko_commissioning_runs(run_id) ON DELETE CASCADE,
  provider text NOT NULL,
  table_name text NOT NULL,
  change_kind text NOT NULL CHECK (change_kind IN ('insert','update')),
  row_ref text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS civiko_commissioning_artifacts_run_idx
  ON public.civiko_commissioning_artifacts (run_id, created_at);
GRANT ALL ON public.civiko_commissioning_artifacts TO service_role;
ALTER TABLE public.civiko_commissioning_artifacts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.civiko_commissioning_claims (
  provider text PRIMARY KEY,
  run_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.civiko_commissioning_claims TO service_role;
ALTER TABLE public.civiko_commissioning_claims ENABLE ROW LEVEL SECURITY;

-- Claim one-shot per provider: TTL bounded, anti-concorrenza, fail-closed.
CREATE OR REPLACE FUNCTION public.civiko_commissioning_claim(
  p_provider text,
  p_run_id uuid,
  p_ttl_seconds integer DEFAULT 600
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ttl integer := LEAST(GREATEST(COALESCE(p_ttl_seconds, 600), 30), 3600);
  v_ok boolean := false;
BEGIN
  IF p_provider IS NULL OR p_run_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_provider NOT IN ('apify','firecrawl','perplexity','chain') THEN
    RETURN false;
  END IF;

  INSERT INTO public.civiko_commissioning_claims (provider, run_id, claimed_at, expires_at)
  VALUES (p_provider, p_run_id, now(), now() + make_interval(secs => v_ttl))
  ON CONFLICT (provider) DO UPDATE
    SET run_id = EXCLUDED.run_id,
        claimed_at = now(),
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    WHERE public.civiko_commissioning_claims.expires_at <= now();

  GET DIAGNOSTICS v_ok = ROW_COUNT;
  RETURN v_ok;
END;
$$;
REVOKE ALL ON FUNCTION public.civiko_commissioning_claim(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.civiko_commissioning_claim(text, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.civiko_commissioning_release_claim(
  p_provider text,
  p_run_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ok boolean := false;
BEGIN
  DELETE FROM public.civiko_commissioning_claims
  WHERE provider = p_provider AND run_id = p_run_id;
  GET DIAGNOSTICS v_ok = ROW_COUNT;
  RETURN v_ok;
END;
$$;
REVOKE ALL ON FUNCTION public.civiko_commissioning_release_claim(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.civiko_commissioning_release_claim(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.civiko_commissioning_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_civiko_commissioning_runs_touch ON public.civiko_commissioning_runs;
CREATE TRIGGER trg_civiko_commissioning_runs_touch
  BEFORE UPDATE ON public.civiko_commissioning_runs
  FOR EACH ROW EXECUTE FUNCTION public.civiko_commissioning_touch_updated_at();

DROP TRIGGER IF EXISTS trg_civiko_commissioning_baselines_touch ON public.civiko_commissioning_baselines;
CREATE TRIGGER trg_civiko_commissioning_baselines_touch
  BEFORE UPDATE ON public.civiko_commissioning_baselines
  FOR EACH ROW EXECUTE FUNCTION public.civiko_commissioning_touch_updated_at();

DROP TRIGGER IF EXISTS trg_civiko_commissioning_claims_touch ON public.civiko_commissioning_claims;
CREATE TRIGGER trg_civiko_commissioning_claims_touch
  BEFORE UPDATE ON public.civiko_commissioning_claims
  FOR EACH ROW EXECUTE FUNCTION public.civiko_commissioning_touch_updated_at();