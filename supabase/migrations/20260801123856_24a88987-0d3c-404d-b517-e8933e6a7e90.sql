
DO $bf$
DECLARE i int; res jsonb;
BEGIN
  FOR i IN 1..4 LOOP
    res := public.padova_backfill_unit_evidence(2000, false);
    EXIT WHEN (res->>'remaining')::int = 0;
  END LOOP;
END
$bf$;
