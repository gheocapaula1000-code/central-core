-- Backfill payload.microzona per i candidati off-market Padova esistenti.
-- Word-boundary su lower(title || ' ' || summary || ' ' || coalesce(location_detail,'')).
-- Ordine CASE = priorità (prima match vince), allineato a PADOVA_MICROZONE_DEFS.
WITH src AS (
  SELECT id,
    lower(
      coalesce(title,'') || ' ' ||
      coalesce(summary,'') || ' ' ||
      coalesce(location_detail,'')
    ) AS hay
  FROM public.early_offmarket_signal_candidates
  WHERE lower(coalesce(comune,'')) = 'padova'
    AND (payload->>'microzona') IS NULL
),
matched AS (
  SELECT id,
    CASE
      WHEN hay ~ '(^|[^a-z0-9])(arcella|pontevigodarzere|ponte di brenta nord)([^a-z0-9]|$)'
        THEN 'pd::arcella'
      WHEN hay ~ '(^|[^a-z0-9])(centro storico|duomo|prato della valle|riviera|centro)([^a-z0-9]|$)'
        THEN 'pd::centro-storico'
      WHEN hay ~ '(^|[^a-z0-9])(mandria|brentella|montà|nord)([^a-z0-9]|$)'
        THEN 'pd::nord'
      WHEN hay ~ '(^|[^a-z0-9])(guizza|bassanello|voltabarozzo|torre|sud)([^a-z0-9]|$)'
        THEN 'pd::sud'
      WHEN hay ~ '(^|[^a-z0-9])(forcellini|salboro|san lazzaro|montà di camin|est)([^a-z0-9]|$)'
        THEN 'pd::est'
      WHEN hay ~ '(^|[^a-z0-9])(sarmeola|rubano|noventa|ovest)([^a-z0-9]|$)'
        THEN 'pd::ovest'
      WHEN hay ~ '(^|[^a-z0-9])(stanga|camin|zona industriale est)([^a-z0-9]|$)'
        THEN 'pd::stanga'
      WHEN hay ~ '(^|[^a-z0-9])(portello|fiera|stazione)([^a-z0-9]|$)'
        THEN 'pd::portello'
      WHEN hay ~ '(^|[^a-z0-9])(albignasego|san giacomo)([^a-z0-9]|$)'
        THEN 'pd::albignasego'
      WHEN hay ~ '(^|[^a-z0-9])(selvazzano|tencarola)([^a-z0-9]|$)'
        THEN 'pd::selvazzano'
      ELSE NULL
    END AS slug
  FROM src
)
UPDATE public.early_offmarket_signal_candidates c
SET payload = coalesce(c.payload, '{}'::jsonb) || jsonb_build_object('microzona', m.slug)
FROM matched m
WHERE c.id = m.id
  AND m.slug IS NOT NULL;