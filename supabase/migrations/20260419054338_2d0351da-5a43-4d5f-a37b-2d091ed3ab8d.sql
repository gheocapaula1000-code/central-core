-- Property ID registry: opaque public IDs ↔ internal Veneto coordinates
-- The opaque token is server-generated and NOT derivable from coordinates.
-- Coordinates are quantized (5 decimals ≈ ~1m) to ensure stable lookup for the same point.

CREATE TABLE IF NOT EXISTS public.property_id_registry (
  id BIGSERIAL PRIMARY KEY,
  opaque_id TEXT NOT NULL UNIQUE,
  lat_scaled INTEGER NOT NULL,
  lng_scaled INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT property_id_registry_coords_unique UNIQUE (lat_scaled, lng_scaled)
);

CREATE INDEX IF NOT EXISTS idx_property_id_registry_opaque
  ON public.property_id_registry (opaque_id);

ALTER TABLE public.property_id_registry ENABLE ROW LEVEL SECURITY;

-- Service role only (edge functions); no public access.
CREATE POLICY "service_role_full_access_property_registry"
  ON public.property_id_registry
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Atomic upsert: returns the existing or newly-created opaque_id for given coordinates.
CREATE OR REPLACE FUNCTION public.property_registry_upsert(
  p_opaque_id TEXT,
  p_lat_scaled INTEGER,
  p_lng_scaled INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing TEXT;
BEGIN
  INSERT INTO public.property_id_registry (opaque_id, lat_scaled, lng_scaled)
  VALUES (p_opaque_id, p_lat_scaled, p_lng_scaled)
  ON CONFLICT (lat_scaled, lng_scaled)
  DO UPDATE SET last_seen_at = now()
  RETURNING opaque_id INTO v_existing;

  RETURN v_existing;
END;
$$;

-- Lookup by opaque id → coordinates
CREATE OR REPLACE FUNCTION public.property_registry_lookup(p_opaque_id TEXT)
RETURNS TABLE(lat_scaled INTEGER, lng_scaled INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT lat_scaled, lng_scaled
  FROM public.property_id_registry
  WHERE opaque_id = p_opaque_id
  LIMIT 1;
$$;