BEGIN;

SELECT pg_advisory_xact_lock(776024010000);

DO $$
DECLARE
  v_dup_cont bigint;
  v_dup_mp   bigint;
BEGIN
  SELECT count(*) INTO v_dup_cont FROM (
    SELECT chiave_match FROM public.padova_contendibili
    WHERE chiave_match IS NOT NULL
    GROUP BY chiave_match HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO v_dup_mp FROM (
    SELECT chiave_match FROM public.padova_multi_portale
    WHERE chiave_match IS NOT NULL
    GROUP BY chiave_match HAVING count(*) > 1
  ) d;
  IF v_dup_cont > 0 OR v_dup_mp > 0 THEN
    RAISE EXCEPTION 'Duplicati chiave_match rilevati: padova_contendibili=%, padova_multi_portale=%. Rollback.', v_dup_cont, v_dup_mp;
  END IF;
END $$;

LOCK TABLE public.padova_contendibili  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.padova_multi_portale IN SHARE ROW EXCLUSIVE MODE;

DROP INDEX IF EXISTS public.padova_contendibili_chiave_match_uniq;
DROP INDEX IF EXISTS public.padova_multi_portale_chiave_match_uniq;

CREATE UNIQUE INDEX padova_contendibili_chiave_match_uniq
  ON public.padova_contendibili (chiave_match);

CREATE UNIQUE INDEX padova_multi_portale_chiave_match_uniq
  ON public.padova_multi_portale (chiave_match);

COMMIT;