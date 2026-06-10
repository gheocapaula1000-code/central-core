
CREATE OR REPLACE FUNCTION public.claim_padova_detail_batch(p_size int DEFAULT 8)
RETURNS TABLE(id bigint, url text, attempts int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT i.id
    FROM public.padova_collect_v2_items i
    WHERE i.url IS NOT NULL
      AND i.attempts < 2
      AND (i.processed_at IS NULL OR i.parse_status IN ('failed_processed_unknown','error'))
    ORDER BY i.id
    LIMIT p_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.padova_collect_v2_items t
  SET attempts = COALESCE(t.attempts, 0) + 1
  FROM picked p
  WHERE t.id = p.id
  RETURNING t.id, t.url, t.attempts;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_padova_detail_batch(int) TO service_role, authenticated, anon;
