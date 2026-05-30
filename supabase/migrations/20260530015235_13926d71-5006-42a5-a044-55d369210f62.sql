-- 1. Inserisci il secret nel Vault SOLO se la GUC di sessione è valorizzata (idempotente)
DO $$
DECLARE
  v_secret text := current_setting('app.central_core_job_secret', true);
BEGIN
  IF v_secret IS NOT NULL AND v_secret <> '' THEN
    INSERT INTO vault.secrets (name, secret)
    VALUES ('central_core_job_secret', v_secret)
    ON CONFLICT (name) DO NOTHING;
  END IF;
END $$;

-- 2. Assicura che agency_operating_areas abbia Padova configurata (idempotente)
INSERT INTO public.agency_operating_areas (
  agency_id, user_id, label, province, comuni, microzones, quartieri, is_active, is_default
)
SELECT
  (SELECT id FROM public.agencies LIMIT 1),
  (SELECT id FROM auth.users ORDER BY created_at ASC LIMIT 1),
  'Padova - Area Principale',
  ARRAY['PD'],
  ARRAY['Padova'],
  ARRAY['arcella','stazione','centro storico','prato della valle','sacra famiglia','guizza','brusegana','forcellini'],
  ARRAY[]::text[],
  true,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM public.agency_operating_areas
  WHERE is_active = true AND comuni @> ARRAY['Padova']
)
AND EXISTS (SELECT 1 FROM public.agencies)
AND EXISTS (SELECT 1 FROM auth.users);

-- 3. Riprogramma i cron Padova (idempotente)
DO $$
BEGIN
  PERFORM cron.unschedule('padova-zone-radar-04');
  PERFORM cron.unschedule('padova-zone-radar-10');
  PERFORM cron.unschedule('padova-zone-radar-20');
  PERFORM cron.unschedule('padova-zone-radar-finalize');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule('padova-zone-radar-04',       '0 4 * * *',  $c$ SELECT private.padova_zone_radar_trigger(6, false); $c$);
SELECT cron.schedule('padova-zone-radar-10',       '10 4 * * *', $c$ SELECT private.padova_zone_radar_trigger(6, false); $c$);
SELECT cron.schedule('padova-zone-radar-20',       '20 4 * * *', $c$ SELECT private.padova_zone_radar_trigger(6, false); $c$);
SELECT cron.schedule('padova-zone-radar-finalize', '30 4 * * *', $c$ SELECT private.padova_zone_radar_trigger(0, true);  $c$);
