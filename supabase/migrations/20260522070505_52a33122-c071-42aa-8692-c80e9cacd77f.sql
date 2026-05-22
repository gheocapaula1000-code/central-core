-- ============================================================
-- Privacy/compliance lock: disable obituary person-level signals
-- ============================================================

-- 1) Wipe any historical person-level data (was 0 rows at lock time)
TRUNCATE TABLE public.obituaries_seen;

-- 2) Mark all configured necrology sources as inactive
UPDATE public.obituaries_sources SET is_active = false;

-- 3) Document the lock at the schema level
COMMENT ON TABLE public.obituaries_seen IS
  'LOCKED 2026-05-22: obituary-derived person-level signals are disabled '
  'for privacy/compliance reasons. Writes are blocked by trigger '
  'trg_obituaries_seen_locked. Do not re-enable without an admin-only '
  'migration and a documented legal basis.';

COMMENT ON TABLE public.obituaries_sources IS
  'LOCKED 2026-05-22: necrology source registry frozen for privacy/'
  'compliance reasons. All rows forced is_active=false. Reactivation '
  'is blocked by trigger trg_obituaries_sources_locked.';

-- 4) Hard block on writes to obituaries_seen (applies to service_role too)
CREATE OR REPLACE FUNCTION public.obituaries_seen_locked()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'obituaries_seen is locked for privacy/compliance. '
    'Person-level obituary signals are disabled. '
    'Re-enable only via an explicit admin migration.'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_obituaries_seen_locked ON public.obituaries_seen;
CREATE TRIGGER trg_obituaries_seen_locked
BEFORE INSERT OR UPDATE ON public.obituaries_seen
FOR EACH ROW EXECUTE FUNCTION public.obituaries_seen_locked();

-- 5) Block reactivation of necrology sources
CREATE OR REPLACE FUNCTION public.obituaries_sources_locked()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.is_active, false) THEN
      RAISE EXCEPTION
        'obituaries_sources is locked: new active sources are not allowed.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(NEW.is_active, false)
     AND NOT COALESCE(OLD.is_active, false) THEN
    RAISE EXCEPTION
      'obituaries_sources is locked: reactivating a source is not allowed.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_obituaries_sources_locked ON public.obituaries_sources;
CREATE TRIGGER trg_obituaries_sources_locked
BEFORE INSERT OR UPDATE ON public.obituaries_sources
FOR EACH ROW EXECUTE FUNCTION public.obituaries_sources_locked();
