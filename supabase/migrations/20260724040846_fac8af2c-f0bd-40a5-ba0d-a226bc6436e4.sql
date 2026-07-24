
-- Backfill comune=Padova per listings attivi con evidenze Padova
WITH quartieri_padova AS (
  SELECT DISTINCT quartiere
  FROM public.padova_listings
  WHERE lower(comune) = 'padova' AND quartiere IS NOT NULL
)
UPDATE public.padova_listings pl
SET comune = 'Padova'
WHERE pl.expired_at IS NULL
  AND pl.comune IS NULL
  AND (
    pl.quartiere IN (SELECT quartiere FROM quartieri_padova)
    OR lower(COALESCE(pl.indirizzo,'')) LIKE '%padova%'
    OR lower(COALESCE(pl.raw_json->>'city','')) LIKE '%padova%'
    OR lower(COALESCE(pl.raw_json->>'comune','')) LIKE '%padova%'
  )
  -- non sovrascrivere se altre evidenze indicano un comune fuori Padova
  AND lower(COALESCE(pl.raw_json->>'city', pl.raw_json->>'comune','')) NOT SIMILAR TO '%(este|monselice|abano|rubano|limena|vigonza|cittadella|selvazzano|albignasego|piove di sacco|conselve|noventa|villafranca|mestrino|piombino|carceri|due carrare|vigodarzere)%';
