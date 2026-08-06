DO $mig$
DECLARE
  v_src text;
  v_out text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'recompute_padova_listings_contendibili';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'recompute_padova_listings_contendibili assente';
  END IF;

  -- (A) impronta testuale forte disponibile fra i candidati fotografici
  IF position('AS descr_fp' in v_src) = 0 THEN
    v_out := replace(v_src,
      E'         public.padova_listing_has_mls_exclusive_evidence(p.raw_json) AS is_mls\n    FROM public.padova_listings p',
      E'         public.padova_listing_has_mls_exclusive_evidence(p.raw_json) AS is_mls,\n         p.ev_descr_fp AS descr_fp\n    FROM public.padova_listings p');
    IF v_out = v_src THEN RAISE EXCEPTION 'patch A: ancora non trovata'; END IF;
    v_src := v_out;
  END IF;

  -- (B) propagazione esplicita dei flag asta/MLS e del testo al candidato
  IF position('z.is_asta, z.is_mls' in v_src) = 0 THEN
    v_out := replace(v_src,
      E'         z.czone_slug, z.canonical_listing_id, z.piano_k, z.tipologia\n    FROM (',
      E'         z.czone_slug, z.canonical_listing_id, z.piano_k, z.tipologia,\n         z.is_asta, z.is_mls, z.descr_fp\n    FROM (');
    IF v_out = v_src THEN RAISE EXCEPTION 'patch B: ancora non trovata'; END IF;
    v_src := v_out;
  END IF;

  -- (C) via non e' veto nel percorso fotografico + banda 10-15% con OR
  IF position('-- matcher v4: prova forte in OR' in v_src) = 0 THEN
    v_out := replace(v_src,
      E'     AND (x.via_n IS NULL OR y.via_n IS NULL OR x.via_n = y.via_n)\n'
      || E'     AND (\n'
      || E'       greatest(x.prezzo, y.prezzo)::numeric <= least(x.prezzo, y.prezzo)::numeric * 1.10\n'
      || E'       OR (\n'
      || E'         greatest(x.prezzo, y.prezzo)::numeric <= least(x.prezzo, y.prezzo)::numeric * 1.15\n'
      || E'         AND coalesce(e.shared_photos, 0) >= 2\n'
      || E'         AND x.piano_k IS NOT NULL AND y.piano_k IS NOT NULL AND x.piano_k = y.piano_k\n'
      || E'         AND x.tipologia IS NOT NULL AND y.tipologia IS NOT NULL AND x.tipologia = y.tipologia\n'
      || E'         AND x.lat IS NOT NULL AND x.lng IS NOT NULL\n'
      || E'         AND y.lat IS NOT NULL AND y.lng IS NOT NULL\n'
      || E'         AND public.padova_haversine_m(x.lat, x.lng, y.lat, y.lng) <= 30\n'
      || E'       )\n'
      || E'     );',
      E'     -- matcher v4: prova forte in OR nella banda 10-15%; la via e''\n'
      || E'     -- soltanto un segnale positivo e mai un veto nel percorso foto.\n'
      || E'     AND (\n'
      || E'       greatest(x.prezzo, y.prezzo)::numeric <= least(x.prezzo, y.prezzo)::numeric * 1.10\n'
      || E'       OR (\n'
      || E'         greatest(x.prezzo, y.prezzo)::numeric <= least(x.prezzo, y.prezzo)::numeric * 1.15\n'
      || E'         AND (\n'
      || E'           coalesce(e.shared_photos, 0) >= 2\n'
      || E'           OR (\n'
      || E'             x.lat IS NOT NULL AND x.lng IS NOT NULL\n'
      || E'             AND y.lat IS NOT NULL AND y.lng IS NOT NULL\n'
      || E'             AND public.padova_haversine_m(x.lat, x.lng, y.lat, y.lng) <= 30\n'
      || E'             AND x.piano_k IS NOT NULL AND y.piano_k IS NOT NULL AND x.piano_k = y.piano_k\n'
      || E'             AND x.tipologia IS NOT NULL AND y.tipologia IS NOT NULL AND x.tipologia = y.tipologia\n'
      || E'             AND x.descr_fp IS NOT NULL AND y.descr_fp IS NOT NULL AND x.descr_fp = y.descr_fp\n'
      || E'           )\n'
      || E'         )\n'
      || E'       )\n'
      || E'     );');
    IF v_out = v_src THEN RAISE EXCEPTION 'patch C: ancora non trovata'; END IF;
    v_src := v_out;
  END IF;

  -- (D) flag asta/MLS esposti dal gruppo: la QA su _img_cert li usa
  IF position('bool_or(m.is_asta) AS has_asta' in v_src) = 0 THEN
    v_out := replace(v_src,
      E'         k.n_rows, k.n_pairs, k.n_pairs AS n_pairs_ok, k.foto_condivise,\n         min(m.czone_slug) AS czone_slug,',
      E'         k.n_rows, k.n_pairs, k.n_pairs AS n_pairs_ok, k.foto_condivise,\n         bool_or(m.is_asta) AS has_asta,\n         bool_or(m.is_mls) AS has_mls,\n         min(m.czone_slug) AS czone_slug,');
    IF v_out = v_src THEN RAISE EXCEPTION 'patch D: ancora non trovata'; END IF;
    v_src := v_out;
  END IF;

  -- (D-bis) esclusione esplicita anche nel filtro dei gruppi ammissibili
  IF position('AND g.has_asta IS NOT TRUE' in v_src) = 0 THEN
    v_out := replace(v_src,
      E'   WHERE g.n_zone = 1\n     AND g.n_locali = 1',
      E'   WHERE g.n_zone = 1\n     AND g.has_asta IS NOT TRUE\n     AND g.has_mls IS NOT TRUE\n     AND g.n_locali = 1');
    IF v_out = v_src THEN RAISE EXCEPTION 'patch D-bis: ancora non trovata'; END IF;
    v_src := v_out;
  END IF;

  -- (E) match_version esplicita v4 (lo stale cleanup rimuove le v3)
  IF position('''v4-unit-certified''' in v_src) = 0 THEN
    v_out := replace(v_src,
      E'v_match_version constant text := ''v3-unit-certified'';',
      E'v_match_version constant text := ''v4-unit-certified'';');
    IF v_out = v_src THEN RAISE EXCEPTION 'patch E: ancora non trovata'; END IF;
    v_src := v_out;
    v_out := replace(v_src,
      E'v_img_match_version constant text := ''v3-unit-certified+image-phash-v1'';',
      E'v_img_match_version constant text := ''v4-unit-certified+image-phash-v1'';');
    IF v_out = v_src THEN RAISE EXCEPTION 'patch E2: ancora non trovata'; END IF;
    v_src := v_out;
  END IF;

  EXECUTE 'CREATE OR REPLACE FUNCTION public.recompute_padova_listings_contendibili() '
       || 'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS '
       || '$fn$' || v_src || '$fn$';
END
$mig$;