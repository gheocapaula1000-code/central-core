-- 20260724010000_civiko_one_chiave_match_conflict_arbiter.sql
-- Fix ON CONFLICT (chiave_match) arbiter for padova_contendibili and padova_multi_portale.
-- Replaces existing UNIQUE indexes (potentially partial) with plain, non-partial UNIQUE indexes.
-- No data, function, view, trigger, ACL or cron is modified.

BEGIN;

-- Dedicated advisory lock (project-scoped identifier)
SELECT pg_advisory_xact_lock(776024010000);

-- Guard: refuse to proceed if duplicate non-NULL chiave_match exist.
DO $$
DECLARE
  v_dup_cont bigint;
  v_dup_mp   bigint;
BEGIN
  SELECT count(*) INTO v_dup_cont
  FROM (
    SELECT chiave_match
    FROM public.padova_contendibili
    WHERE chiave_match IS NOT NULL
    GROUP BY chiave_match
    HAVING count(*) > 1
  ) d;

  SELECT count(*) INTO v_dup_mp
  FROM (
    SELECT chiave_match
    FROM public.padova_multi_portale
    WHERE chiave_match IS NOT NULL
    GROUP BY chiave_match
    HAVING count(*) > 1
  ) d;

  IF v_dup_cont > 0 OR v_dup_mp > 0 THEN
    RAISE EXCEPTION
      'Duplicati chiave_match rilevati: padova_contendibili=%, padova_multi_portale=%. Rollback: nessuna cancellazione automatica.',
      v_dup_cont, v_dup_mp;
  END IF;
END
$$;

-- Bloccante: acquisisce EXCLUSIVE lock sulle tabelle
LOCK TABLE public.padova_contendibili  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.padova_multi_portale IN SHARE ROW EXCLUSIVE MODE;

-- Drop esclusivamente i due indici target
DROP INDEX IF EXISTS public.padova_contendibili_chiave_match_uniq;
DROP INDEX IF EXISTS public.padova_multi_portale_chiave_match_uniq;

-- Ricrea come UNIQUE INDEX normali (no WHERE, no espressioni)
CREATE UNIQUE INDEX padova_contendibili_chiave_match_uniq
  ON public.padova_contendibili (chiave_match);

CREATE UNIQUE INDEX padova_multi_portale_chiave_match_uniq
  ON public.padova_multi_portale (chiave_match);

COMMIT;
