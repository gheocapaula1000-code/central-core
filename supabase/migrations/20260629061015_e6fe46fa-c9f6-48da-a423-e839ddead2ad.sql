
CREATE TABLE IF NOT EXISTS public.civiko_commercial_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  nome text NOT NULL,
  descrizione text,
  omi_codes text[] NOT NULL,
  canone_mese_eur integer NOT NULL,
  tier text NOT NULL CHECK (tier IN ('premium','standard','entry')),
  provvigioni_anno_eur bigint,
  contendibili_count integer DEFAULT 0,
  stripe_price_id text,
  agency_id uuid REFERENCES public.agencies(id),
  attiva boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

GRANT SELECT ON public.civiko_commercial_zones TO authenticated;
GRANT ALL ON public.civiko_commercial_zones TO service_role;

ALTER TABLE public.civiko_commercial_zones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read commercial zones"
  ON public.civiko_commercial_zones
  FOR SELECT
  TO authenticated
  USING (true);

INSERT INTO public.civiko_commercial_zones
  (slug, nome, descrizione, omi_codes, canone_mese_eur, tier, provvigioni_anno_eur, contendibili_count)
VALUES
  ('centro-storico', 'Centro Storico', 'B1 Riviere + B2 Carmine/Savonarola/S.Sofia', ARRAY['B1','B2'], 2990, 'premium', 7574951, 114),
  ('palestro-sacra-famiglia', 'Palestro / Sacra Famiglia', 'C6 Palestro/Sacra Famiglia', ARRAY['C6'], 2490, 'premium', 3904770, 38),
  ('portello-stazione-fiera', 'Portello / Stazione / Fiera', 'C1 Portello + C2 Stazione/Scrovegni + C4 Direzionale', ARRAY['C1','C2','C4'], 1990, 'standard', 1733597, 20),
  ('madonna-pellegrina-bassanello', 'Madonna Pellegrina / Bassanello', 'C5 Madonna Pellegrina/S.Rita + D3 Bassanello/Guizza', ARRAY['C5','D3'], 1990, 'standard', 4132200, 62),
  ('arcella-nord-torre', 'Arcella Nord / Torre', 'D5 Altichiero/Montà + D6 Pontevigodarzere/Torre + D7 Arcella Nord/Mortise', ARRAY['D5','D6','D7'], 1490, 'standard', 2247186, 62),
  ('prima-arcella-direzionale', 'Prima Arcella', 'C3 Borgomagno/Prima Arcella', ARRAY['C3'], 1490, 'standard', 332440, 14),
  ('paltana-brusegana-ovest', 'Paltana / Brusegana / Ovest', 'D1 Chiesanuova/Brusegana + D2 Paltana/Mandria + R1 Rurale nord + R2 Rurale ovest', ARRAY['D1','D2','R1','R2'], 1490, 'standard', 2021289, 38),
  ('ponte-brenta-forcellini', 'Ponte di Brenta / Forcellini', 'D4 Ponte di Brenta/S.Lazzaro + D8 Forcellini/Terranegra', ARRAY['D4','D8'], 1490, 'standard', 1609586, 14),
  ('camin-zip', 'Camin / ZIP', 'E1 Camin + E2 Zona Industriale/ZIP', ARRAY['E1','E2'], 990, 'entry', 375010, 12),
  ('sud-rurale', 'Sud / Rurale', 'E3 Salboro + R3 Rurale sud', ARRAY['E3','R3'], 990, 'entry', 150055, 2)
ON CONFLICT (slug) DO NOTHING;
