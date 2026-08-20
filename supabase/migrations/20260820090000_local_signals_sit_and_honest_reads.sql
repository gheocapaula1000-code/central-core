-- OSM cantieri → local_signals identity + zone view.
-- sit_padova_geoportale is wired via cartografia.comune.padova.it (sit.padovanet.it does not resolve).
-- Live Core only. Does not target central-core-prod. Does not invent rows.

ALTER TABLE public.local_signals
  ADD COLUMN IF NOT EXISTS commercial_zone_slug text,
  ADD COLUMN IF NOT EXISTS external_ref text;

UPDATE public.local_signals
   SET external_ref = COALESCE(NULLIF(external_ref, ''), 'legacy:local_signal:' || id::text)
 WHERE external_ref IS NULL OR external_ref = '';

CREATE UNIQUE INDEX IF NOT EXISTS local_signals_external_ref_uniq
  ON public.local_signals (external_ref);

CREATE INDEX IF NOT EXISTS local_signals_zone_idx
  ON public.local_signals (commercial_zone_slug, detected_at DESC);

INSERT INTO public.local_sources (name, type, level, url, source_owner, municipality, is_active)
SELECT
  'OpenStreetMap Overpass — cantieri Padova',
  'osm_overpass',
  2,
  'https://overpass-api.de/api/interpreter',
  'OpenStreetMap',
  'Padova',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM public.local_sources
   WHERE name = 'OpenStreetMap Overpass — cantieri Padova'
);

DROP VIEW IF EXISTS public.local_signals_by_zone_v;
CREATE VIEW public.local_signals_by_zone_v AS
SELECT s.*
  FROM public.local_signals s
 WHERE s.is_active = true
   AND coalesce(s.municipality, '') ILIKE 'Padova'
   AND s.commercial_zone_slug IN (
     'centro-storico','nord-arcella','est-brenta','nord-est',
     'sud-est-sant-osvaldo','sud-voltabarozzo-guizza',
     'sud-ovest-mandria','ovest-chiesanuova-brentelle'
   );

REVOKE ALL ON public.local_signals_by_zone_v FROM PUBLIC, anon;
GRANT SELECT ON public.local_signals_by_zone_v TO authenticated, service_role;

-- F18 / F5 notes: OSM now lands in sue_padova_permits + local_signals.
UPDATE public.civiko_source_registry
SET
  notes = 'Official Comune / CKAN / OSM construction → sue_padova_permits. OSM also → local_signals. Empty OK if sources up; fail-closed if unread. trovabandi is grants, not cantieri.'
WHERE source_code = 'F18';

UPDATE public.civiko_source_registry
SET
  notes = 'OSM Overpass → ingest-opportunity AND Padova rows into sue_padova_permits + local_signals.'
WHERE source_code = 'F5';
