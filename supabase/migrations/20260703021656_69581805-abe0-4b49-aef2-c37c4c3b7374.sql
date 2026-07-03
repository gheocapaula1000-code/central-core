
-- 1) Sposta il lock: obituaries_seen (person-level) resta congelata a livello DB.
CREATE OR REPLACE FUNCTION public.obituaries_seen_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION
    'obituaries_seen is frozen: person-level obituary storage is disabled by policy. Use obituaries_aggregate_padova (aggregate k>=3, PII-free).'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_obituaries_seen_frozen ON public.obituaries_seen;
CREATE TRIGGER trg_obituaries_seen_frozen
  BEFORE INSERT OR UPDATE ON public.obituaries_seen
  FOR EACH ROW EXECUTE FUNCTION public.obituaries_seen_frozen();

-- 2) Rilassa il lock su obituaries_sources: la nuova ingestion è aggregata/PII-free.
DROP TRIGGER IF EXISTS trg_obituaries_sources_locked ON public.obituaries_sources;

-- 3) Hard cap k=3 sui bucket aggregati (belt-and-suspenders).
ALTER TABLE public.obituaries_aggregate_padova
  ADD CONSTRAINT obituaries_aggregate_bucket_min_k
  CHECK (bucket_count >= 3);

-- 4) Index utile alla heatmap (lookup per area_code + finestra recente)
CREATE INDEX IF NOT EXISTS idx_obituaries_agg_area_last
  ON public.obituaries_aggregate_padova (area_type, area_code, window_end DESC);

-- 5) Attiva le 3 sorgenti Veneto per l'ingestion aggregata.
UPDATE public.obituaries_sources
   SET is_active = true
 WHERE region = 'veneto'
   AND name IN ('Necrologie.it','Il Gazzettino - Necrologie','Lutto.it Veneto');
