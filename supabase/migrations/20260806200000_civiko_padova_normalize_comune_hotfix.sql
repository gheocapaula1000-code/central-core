-- Civiko-only forward hotfix: the 20260806194355 normalizer stripped the
-- canonical value "Padova" itself because "padova" was accepted as a bare
-- suffix. Keep suffix removal delimiter-aware so the canonical municipality
-- can never collapse to NULL. No table data is mutated by this migration.

CREATE OR REPLACE FUNCTION public.civiko_normalize_comune(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $function$
  WITH folded AS (
    SELECT lower(btrim(coalesce(public.civiko_ascii_fold(p_value), ''))) AS value
  ), unprefixed AS (
    SELECT regexp_replace(
      regexp_replace(
        value,
        '^comune[[:space:]]+di[[:space:]]+',
        '',
        'i'
      ),
      '^(citta''?|city)[[:space:]]+(di|of)[[:space:]]+',
      '',
      'i'
    ) AS value
    FROM folded
  ), suffix_once AS (
    SELECT regexp_replace(
      value,
      '([[:space:]]*\([[:space:]]*(pd|padova|italia|italy|veneto)[[:space:]]*\)|[[:space:]]*,[[:space:]]*(pd|padova|italia|italy|veneto)|[[:space:]]+pd)[[:space:]]*$',
      '',
      'i'
    ) AS value
    FROM unprefixed
  ), suffix_twice AS (
    SELECT regexp_replace(
      value,
      '([[:space:]]*\([[:space:]]*(pd|padova|italia|italy|veneto)[[:space:]]*\)|[[:space:]]*,[[:space:]]*(pd|padova|italia|italy|veneto)|[[:space:]]+pd)[[:space:]]*$',
      '',
      'i'
    ) AS value
    FROM suffix_once
  )
  SELECT nullif(
    regexp_replace(
      btrim(regexp_replace(value, '[.;:]+$', '', 'g')),
      '[[:space:]]+',
      ' ',
      'g'
    ),
    ''
  )
  FROM suffix_twice;
$function$;

CREATE OR REPLACE FUNCTION public.civiko_is_comune_padova(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $function$
  SELECT coalesce(public.civiko_normalize_comune(p_value), '') = 'padova';
$function$;

GRANT EXECUTE ON FUNCTION public.civiko_normalize_comune(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.civiko_is_comune_padova(text) TO authenticated, service_role;

-- Fail closed inside the migration: a bad canonical result rolls back the
-- CREATE OR REPLACE statements in the same transaction.
DO $assert$
DECLARE
  v_input text;
BEGIN
  FOREACH v_input IN ARRAY ARRAY[
    'Padova',
    ' PADOVA ',
    'Comune di Padova',
    'Padova (PD)',
    'Padova, PD',
    'Padova, Italia',
    'Padova (PD), Italia',
    'Padova PD'
  ]
  LOOP
    IF public.civiko_normalize_comune(v_input) IS DISTINCT FROM 'padova'
       OR public.civiko_is_comune_padova(v_input) IS NOT TRUE THEN
      RAISE EXCEPTION 'CIVIKO_PADOVA_NORMALIZE_ASSERT_FAILED input=% normalized=%',
        v_input,
        public.civiko_normalize_comune(v_input);
    END IF;
  END LOOP;

  IF public.civiko_normalize_comune('Vigonza') IS DISTINCT FROM 'vigonza'
     OR public.civiko_is_comune_padova('Vigonza') IS NOT FALSE THEN
    RAISE EXCEPTION 'CIVIKO_PADOVA_NEGATIVE_ASSERT_FAILED';
  END IF;

  IF public.civiko_normalize_comune(NULL) IS NOT NULL
     OR public.civiko_is_comune_padova(NULL) IS NOT FALSE THEN
    RAISE EXCEPTION 'CIVIKO_PADOVA_NULL_ASSERT_FAILED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.padova_listings l
    WHERE lower(btrim(coalesce(l.comune, ''))) = 'padova'
      AND public.civiko_is_comune_padova(l.comune) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'CIVIKO_EXISTING_PADOVA_ROWS_ASSERT_FAILED';
  END IF;
END
$assert$;
