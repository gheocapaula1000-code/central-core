CREATE POLICY "public_read_territorial_rs" ON public.radar_signals
  FOR SELECT TO authenticated
  USING (agency_id IS NULL AND is_active = true);