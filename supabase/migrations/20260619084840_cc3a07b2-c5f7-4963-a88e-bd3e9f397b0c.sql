-- =====================================================================
-- Lead privati Subito + Bakeca — registry, budget guard, scheduling
-- =====================================================================

-- 1. Disattiva fonte aste esistente (mercato verticale, non genera incarichi)
UPDATE public.civiko_data_sources
   SET is_active = false,
       notes = COALESCE(notes,'') || ' [DISATTIVATA 2026-06-19] Mercato verticale già presidiato. Aste non producono incarichi di vendita per agenti immobiliari. Risorse spostate su lead privati Subito/Bakeca.',
       updated_at = now()
 WHERE code = 'aste_giudiziarie';

-- 2. Inserisce 4 righe esplicite aste come disattivate per tracciabilità
INSERT INTO public.civiko_data_sources
  (code, label, description, category, status, provider, base_url, env_var,
   coverage, requires_premium_consent, estimated_cost_eur, notes, display_order, is_active)
VALUES
  ('aste_giudiziarie_veneto', 'AsteGiudiziarie.it Veneto',
   'Portale aste giudiziarie regione Veneto',
   'manual_or_phase_2'::text, 'phase_2'::text, 'astegiudiziarie.it',
   'https://www.astegiudiziarie.it', NULL, 'Veneto', false, NULL,
   'DISATTIVATA 2026-06-19. Mercato verticale già presidiato. Aste non producono incarichi di vendita per agenti immobiliari. Risorse spostate su lead privati Subito/Bakeca.',
   500, false),
  ('tribunale_padova', 'Tribunale Padova',
   'Vendite giudiziarie tribunale di Padova',
   'manual_or_phase_2'::text, 'phase_2'::text, 'pvp.giustizia.it',
   'https://pvp.giustizia.it', NULL, 'Padova', false, NULL,
   'DISATTIVATA 2026-06-19. Mercato verticale già presidiato. Aste non producono incarichi di vendita per agenti immobiliari. Risorse spostate su lead privati Subito/Bakeca.',
   501, false),
  ('tribunale_venezia', 'Tribunale Venezia',
   'Vendite giudiziarie tribunale di Venezia',
   'manual_or_phase_2'::text, 'phase_2'::text, 'pvp.giustizia.it',
   'https://pvp.giustizia.it', NULL, 'Venezia', false, NULL,
   'DISATTIVATA 2026-06-19. Mercato verticale già presidiato. Aste non producono incarichi di vendita per agenti immobiliari. Risorse spostate su lead privati Subito/Bakeca.',
   502, false),
  ('tribunale_verona', 'Tribunale Verona',
   'Vendite giudiziarie tribunale di Verona',
   'manual_or_phase_2'::text, 'phase_2'::text, 'pvp.giustizia.it',
   'https://pvp.giustizia.it', NULL, 'Verona', false, NULL,
   'DISATTIVATA 2026-06-19. Mercato verticale già presidiato. Aste non producono incarichi di vendita per agenti immobiliari. Risorse spostate su lead privati Subito/Bakeca.',
   503, false)
ON CONFLICT (code) DO UPDATE SET
  is_active = false,
  notes = EXCLUDED.notes,
  updated_at = now();

-- 3. Inserisce le 2 nuove fonti private connesse
INSERT INTO public.civiko_data_sources
  (code, label, description, category, status, provider, base_url, env_var,
   coverage, requires_premium_consent, estimated_cost_eur, notes, display_order, is_active)
VALUES
  ('subito_padova_privati', 'Subito Padova — Annunci privati',
   'Annunci di vendita immobiliare di privati su Subito.it (only_private). Anzianità >=60gg classificata privato_stanco.',
   'premium'::text, 'connected'::text, 'apify+subito.it',
   'https://www.subito.it/annunci-padova/vendita/immobili/padova/', 'APIFY_API_TOKEN',
   'Padova città e provincia', false, 5,
   'Attivata 2026-06-19. Cron notturno civiko-private-leads-nightly. Cap mensile combinato con Bakeca: 8 USD.',
   200, true),
  ('bakeca_padova_privati', 'Bakeca Padova — Annunci privati',
   'Annunci immobili in vendita da privati su Bakeca.it. Scraping Firecrawl markdown. Anzianità >=60gg classificata privato_stanco.',
   'premium'::text, 'connected'::text, 'firecrawl+bakeca.it',
   'https://www.bakeca.it/annunci/immobili-vendita/padova/', 'FIRECRAWL_API_KEY',
   'Padova città e provincia', false, 3,
   'Attivata 2026-06-19. Cron notturno civiko-private-leads-nightly. Cap mensile combinato con Subito: 8 USD.',
   201, true)
ON CONFLICT (code) DO UPDATE SET
  is_active = true,
  status = 'connected',
  notes = EXCLUDED.notes,
  updated_at = now();

-- 4. Tabella visibilità run notturni
CREATE TABLE IF NOT EXISTS public.private_leads_run_status (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opportunita_totali INTEGER NOT NULL DEFAULT 0,
  privato_stanco_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  error_message TEXT,
  duration_ms INTEGER,
  notes JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS private_leads_run_status_source_idx
  ON public.private_leads_run_status (source, last_run_at DESC);

GRANT SELECT ON public.private_leads_run_status TO authenticated;
GRANT ALL ON public.private_leads_run_status TO service_role;
ALTER TABLE public.private_leads_run_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin read private_leads_run_status" ON public.private_leads_run_status;
CREATE POLICY "admin read private_leads_run_status"
  ON public.private_leads_run_status FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 5. Tabella budget mensile combinato Subito + Bakeca
CREATE TABLE IF NOT EXISTS public.private_leads_spend_monthly (
  year_month TEXT PRIMARY KEY,
  apify_usd NUMERIC NOT NULL DEFAULT 0,
  firecrawl_usd NUMERIC NOT NULL DEFAULT 0,
  total_usd NUMERIC GENERATED ALWAYS AS (apify_usd + firecrawl_usd) STORED,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.private_leads_spend_monthly TO authenticated;
GRANT ALL ON public.private_leads_spend_monthly TO service_role;
ALTER TABLE public.private_leads_spend_monthly ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin read private_leads_spend" ON public.private_leads_spend_monthly;
CREATE POLICY "admin read private_leads_spend"
  ON public.private_leads_spend_monthly FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 6. Schedula il cron notturno alle 02:25 UTC
DO $$
DECLARE
  v_existing INT;
BEGIN
  SELECT count(*) INTO v_existing FROM cron.job WHERE jobname = 'civiko-private-leads-nightly';
  IF v_existing > 0 THEN
    PERFORM cron.unschedule('civiko-private-leads-nightly');
  END IF;

  PERFORM cron.schedule(
    'civiko-private-leads-nightly',
    '25 2 * * *',
    $cron$
    SELECT public.log_cron_http_invocation(
      'civiko-private-leads-nightly',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-private-leads-nightly',
      '{"trigger":"cron"}'::jsonb
    );
    $cron$
  );
END $$;