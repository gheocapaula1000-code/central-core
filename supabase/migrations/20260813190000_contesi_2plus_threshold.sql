-- Contesi 2+: restore MIN_AGENZIE = 2 (era 3 dopo 20260808122854).
-- HOT resta un concetto solo di UI/display (3+ agenzie), non di scrittura.
-- Filtri prezzo (<=15%), foto, asta/MLS, identity restano invariati.

CREATE OR REPLACE FUNCTION public.civiko_padova_img_group_gate_ok(
  p_n_zone bigint,
  p_has_asta boolean,
  p_has_mls boolean,
  p_n_agenzie bigint,
  p_n_annunci_canonici bigint,
  p_n_rows integer,
  p_n_pairs bigint,
  p_n_pairs_attese bigint,
  p_n_pairs_over15 bigint,
  p_n_pairs_photo_weak bigint,
  p_n_pairs_photo bigint,
  p_prezzo_min numeric,
  p_prezzo_max numeric,
  p_mq_min numeric,
  p_mq_max numeric,
  p_n_locali bigint,
  p_n_bagni bigint,
  p_n_piani bigint,
  p_n_tipologie bigint
)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    -- REJECT COMUNI A OGNI RAMO
    p_n_zone = 1
    AND p_has_asta IS NOT TRUE
    AND p_has_mls IS NOT TRUE
    AND p_n_agenzie >= 2
    AND p_n_annunci_canonici >= 2
    AND p_n_annunci_canonici = p_n_rows
    AND p_n_rows BETWEEN 2 AND 4
    AND p_n_pairs = p_n_pairs_attese          -- complete-link obbligatorio
    AND coalesce(p_n_pairs_over15, 0) = 0
    AND coalesce(p_n_pairs_photo_weak, 0) = 0
    AND p_prezzo_min > 0
    AND p_prezzo_max <= p_prezzo_min * 1.15   -- prezzo sempre obbligatorio
    AND (
      -- RAMO PHOTO/MISTO: nessun requisito di mq/locali/bagni/piano/tipologia
      coalesce(p_n_pairs_photo, 0) > 0
      OR (
        -- RAMO INTERAMENTE STRUCTURAL: metadata pienamente obbligatori
        coalesce(p_mq_min, 0) > 0
        AND p_mq_max <= greatest(p_mq_min + 5, p_mq_min * 1.05)
        AND p_n_locali = 1
        AND p_n_bagni <= 1
        AND p_n_piani <= 1
        AND p_n_tipologie <= 1
      )
    );
$function$;

DO $mig$
DECLARE
  d text;
  n text;
  prev text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'recompute_padova_listings_contendibili';
  IF d IS NULL THEN
    RAISE EXCEPTION 'Patch fail-closed: recompute_padova_listings_contendibili non trovata';
  END IF;
  n := d;

  -- 1) staging unit-certified: 2 agenzie / 2 annunci canonici / >= 2 righe
  prev := n;
  n := replace(n,
    'WHERE n_agenzie >= 3
    AND n_annunci_canonici >= 3
    AND n_rows BETWEEN 3 AND 8',
    'WHERE n_agenzie >= 2
    AND n_annunci_canonici >= 2
    AND n_rows BETWEEN 2 AND 8');
  IF n = prev THEN
    -- tollera se già a 2 (idempotente)
    IF position('WHERE n_agenzie >= 2' in n) = 0 THEN
      RAISE EXCEPTION 'Patch fail-closed: blocco _unit_ok atteso non trovato (né 3 né 2)';
    END IF;
  END IF;

  -- 2) QA staging _cert
  prev := n;
  n := replace(n,
    'FROM _cert
   WHERE n_agenzie < 3
      OR coalesce(n_annunci_canonici, 0) < 3',
    'FROM _cert
   WHERE n_agenzie < 2
      OR coalesce(n_annunci_canonici, 0) < 2');
  IF n = prev AND position('n_agenzie < 2' in n) = 0 THEN
    RAISE EXCEPTION 'Patch fail-closed: QA staging _cert attesa non trovata';
  END IF;

  -- 3) QA staging _img_cert (coppie v4)
  prev := n;
  n := replace(n,
    'FROM _img_cert
   WHERE n_agenzie < 3
      OR coalesce(n_annunci_canonici, 0) < 3',
    'FROM _img_cert
   WHERE n_agenzie < 2
      OR coalesce(n_annunci_canonici, 0) < 2');
  IF n = prev AND position('FROM _img_cert' in n) > 0 AND position('n_agenzie < 2' in n) = 0 THEN
    RAISE EXCEPTION 'Patch fail-closed: QA staging _img_cert attesa non trovata';
  END IF;

  -- 4) QA post-scrittura
  prev := n;
  n := replace(n,
    'WHERE match_version NOT IN (v_match_version, v_img_match_version, v_pair_match_version)
      OR n_agenzie < 3',
    'WHERE match_version NOT IN (v_match_version, v_img_match_version, v_pair_match_version)
      OR n_agenzie < 2');
  IF n = prev AND position('OR n_agenzie < 2' in n) = 0 THEN
    RAISE EXCEPTION 'Patch fail-closed: QA post-scrittura attesa non trovata';
  END IF;

  -- 5) QA identita canonica: almeno 2 annunci canonici distinti
  prev := n;
  n := replace(n,
    '   ) < 3;
  IF v_bad > 0 THEN
    RAISE EXCEPTION ''QA identita canonica fallita: % contendibili con meno di 3 annunci canonici distinti'', v_bad;',
    '   ) < 2;
  IF v_bad > 0 THEN
    RAISE EXCEPTION ''QA identita canonica fallita: % contendibili con meno di 2 annunci canonici distinti'', v_bad;');
  IF n = prev AND position('meno di 2 annunci canonici' in n) = 0 THEN
    -- fallback pattern more tolerant
    n := replace(n,
      'meno di 3 annunci canonici distinti',
      'meno di 2 annunci canonici distinti');
    n := replace(n, ') < 3;', ') < 2;');
  END IF;

  -- 6) QA coppie v4 post-scrittura: canonici >= 2
  prev := n;
  n := replace(n,
    'OR coalesce((pc.match_metrics->>''n_annunci_canonici'')::int, 0) < 3',
    'OR coalesce((pc.match_metrics->>''n_annunci_canonici'')::int, 0) < 2');
  IF n = prev THEN
    -- may already be at 2
    NULL;
  END IF;

  EXECUTE n;

  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'recompute_padova_listings_contendibili';
  IF d NOT LIKE '%WHERE n_agenzie >= 2%'
     OR d LIKE '%WHERE n_agenzie >= 3%' THEN
    RAISE EXCEPTION 'Verifica post-patch fallita: soglia Contesi 2+ non installata (staging)';
  END IF;
  IF d LIKE '%OR n_agenzie < 3%' OR d LIKE '%n_agenzie < 3%' THEN
    -- allow residual only if both patterns coexist during partial apply; fail if QA still exclusive to 3
    IF d NOT LIKE '%OR n_agenzie < 2%' AND d NOT LIKE '%n_agenzie < 2%' THEN
      RAISE EXCEPTION 'Verifica post-patch fallita: QA ancora a soglia 3';
    END IF;
  END IF;
END
$mig$;
