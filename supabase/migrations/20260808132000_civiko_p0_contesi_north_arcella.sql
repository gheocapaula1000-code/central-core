-- Civiko Core P0: north-arcella aliases and cross-zone quarantine.
-- Provider-free, replay-safe, with pre-change evidence backup.
BEGIN;

CREATE TABLE IF NOT EXISTS public._bkp_20260808_civiko_p0_north_arcella (
  source_table text NOT NULL,
  source_id text NOT NULL,
  row_data jsonb NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_id)
);
REVOKE ALL ON public._bkp_20260808_civiko_p0_north_arcella
  FROM PUBLIC, anon, authenticated;

-- Preserve every row affected by the alias correction.
INSERT INTO public._bkp_20260808_civiko_p0_north_arcella(source_table, source_id, row_data)
SELECT 'civiko_quartiere_commercial_zone_map', quartiere_key, to_jsonb(t)
FROM public.civiko_quartiere_commercial_zone_map t
WHERE quartiere_key IN (
  'altichiero','altichero','sacro cuore',
  'ovest sacra famiglia chiesanuova brusegana altichiero',
  's ignazio monta altichiero','torre pontevigodarzere sacro cuore'
)
ON CONFLICT DO NOTHING;

INSERT INTO public._bkp_20260808_civiko_p0_north_arcella(source_table, source_id, row_data)
SELECT 'quartiere_zona_map', quartiere_key, to_jsonb(t)
FROM public.quartiere_zona_map t
WHERE quartiere_key IN (
  'altichiero','altichero','sacro cuore',
  'ovest sacra famiglia chiesanuova brusegana altichiero',
  's ignazio monta altichiero','torre pontevigodarzere sacro cuore'
)
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY[
    'padova_listings','padova_cambi_agenzia','padova_contendibili',
    'padova_multi_portale','padova_contendibili_quarantena',
    'padova_multi_portale_quarantena'
  ]
  LOOP
    EXECUTE format(
      'INSERT INTO public._bkp_20260808_civiko_p0_north_arcella(source_table, source_id, row_data)
       SELECT %L, id::text, to_jsonb(t)
       FROM public.%I t
       WHERE public.civiko_normalize_quartiere(quartiere) IN (
         %L,%L,%L,%L,%L,%L
       )
       ON CONFLICT DO NOTHING',
      tab, tab,
      'altichiero','altichero','sacro cuore',
      'ovest sacra famiglia chiesanuova brusegana altichiero',
      's ignazio monta altichiero','torre pontevigodarzere sacro cuore'
    );
  END LOOP;
END
$$;

INSERT INTO public.civiko_quartiere_commercial_zone_map
  (quartiere_key, commercial_zone_slug, created_at)
VALUES
  ('altichiero','nord-arcella',now()),
  ('altichero','nord-arcella',now()),
  ('sacro cuore','nord-arcella',now())
ON CONFLICT (quartiere_key) DO UPDATE
SET commercial_zone_slug = EXCLUDED.commercial_zone_slug;

DELETE FROM public.civiko_quartiere_commercial_zone_map
WHERE quartiere_key IN (
  'ovest sacra famiglia chiesanuova brusegana altichiero',
  's ignazio monta altichiero',
  'torre pontevigodarzere sacro cuore'
);

UPDATE public.quartiere_zona_map
SET zona_slug = 'nord-arcella'
WHERE quartiere_key IN ('altichiero','altichero','sacro cuore');

DELETE FROM public.quartiere_zona_map
WHERE quartiere_key IN (
  'ovest sacra famiglia chiesanuova brusegana altichiero',
  's ignazio monta altichiero',
  'torre pontevigodarzere sacro cuore'
);

UPDATE public.padova_listings
SET commercial_zone_slug = 'nord-arcella',
    zone_match_method = 'quartiere_exact_v3',
    zone_match_confidence = 1,
    zone_resolved_at = now()
WHERE public.civiko_normalize_quartiere(quartiere)
  IN ('altichiero','altichero','sacro cuore');

UPDATE public.padova_listings
SET commercial_zone_slug = NULL,
    zone_match_method = 'ambiguous_cross_zone_v3',
    zone_match_confidence = 0,
    zone_resolved_at = now()
WHERE public.civiko_normalize_quartiere(quartiere) IN (
  'ovest sacra famiglia chiesanuova brusegana altichiero',
  's ignazio monta altichiero',
  'torre pontevigodarzere sacro cuore'
);

UPDATE public.padova_cambi_agenzia
SET commercial_zone_slug = 'nord-arcella'
WHERE public.civiko_normalize_quartiere(quartiere)
  IN ('altichiero','altichero','sacro cuore');
UPDATE public.padova_cambi_agenzia
SET commercial_zone_slug = NULL
WHERE public.civiko_normalize_quartiere(quartiere) IN (
  'ovest sacra famiglia chiesanuova brusegana altichiero',
  's ignazio monta altichiero',
  'torre pontevigodarzere sacro cuore'
);

UPDATE public.padova_contendibili_quarantena
SET commercial_zone_slug = 'nord-arcella'
WHERE public.civiko_normalize_quartiere(quartiere)
  IN ('altichiero','altichero','sacro cuore');
UPDATE public.padova_contendibili_quarantena
SET commercial_zone_slug = NULL
WHERE public.civiko_normalize_quartiere(quartiere) IN (
  'ovest sacra famiglia chiesanuova brusegana altichiero',
  's ignazio monta altichiero',
  'torre pontevigodarzere sacro cuore'
);

UPDATE public.padova_multi_portale_quarantena
SET commercial_zone_slug = 'nord-arcella'
WHERE public.civiko_normalize_quartiere(quartiere)
  IN ('altichiero','altichero','sacro cuore');
UPDATE public.padova_multi_portale_quarantena
SET commercial_zone_slug = NULL
WHERE public.civiko_normalize_quartiere(quartiere) IN (
  'ovest sacra famiglia chiesanuova brusegana altichiero',
  's ignazio monta altichiero',
  'torre pontevigodarzere sacro cuore'
);

-- Publishable aggregates cannot be made NULL. Abort rather than guess.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.padova_contendibili
    WHERE public.civiko_normalize_quartiere(quartiere) IN (
      'ovest sacra famiglia chiesanuova brusegana altichiero',
      's ignazio monta altichiero',
      'torre pontevigodarzere sacro cuore'
    )
  ) OR EXISTS (
    SELECT 1 FROM public.padova_multi_portale
    WHERE public.civiko_normalize_quartiere(quartiere) IN (
      'ovest sacra famiglia chiesanuova brusegana altichiero',
      's ignazio monta altichiero',
      'torre pontevigodarzere sacro cuore'
    )
  ) THEN
    RAISE EXCEPTION 'AMBIGUOUS_PUBLISHABLE_ROWS_REQUIRE_QUARANTINE';
  END IF;
END
$$;

UPDATE public.padova_contendibili
SET commercial_zone_slug = 'nord-arcella'
WHERE public.civiko_normalize_quartiere(quartiere)
  IN ('altichiero','altichero','sacro cuore');
UPDATE public.padova_multi_portale
SET commercial_zone_slug = 'nord-arcella'
WHERE public.civiko_normalize_quartiere(quartiere)
  IN ('altichiero','altichero','sacro cuore');

UPDATE public.civiko_commercial_zones z
SET contendibili_count = (
  SELECT count(*)::integer
  FROM public.padova_contendibili c
  WHERE c.commercial_zone_slug = z.slug
);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.civiko_commercial_zones) <> 8
     OR EXISTS (
       SELECT 1 FROM public.civiko_commercial_zones
       WHERE slug = 'est-forcellini-camin'
     ) THEN
    RAISE EXCEPTION 'TERRITORY_CONTRACT_POSTCONDITION_FAILED';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.civiko_quartiere_commercial_zone_map
    WHERE quartiere_key IN ('altichiero','altichero','sacro cuore')
      AND commercial_zone_slug <> 'nord-arcella'
  ) THEN
    RAISE EXCEPTION 'NORTH_ALIAS_POSTCONDITION_FAILED';
  END IF;
END
$$;

COMMIT;
