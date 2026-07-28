-- ============================================================================
-- MIGRATION TERRITORIALE MINIMA — Padova Pilot v1
-- NOME: 20260728120000_civiko_remove_ambiguous_stazione_fiera_key.sql
-- STATO: CREATA, **NON APPLICATA**. Nessun db push eseguito.
--
-- SCOPO (unico): rimuovere dalla mappa quartiere→zona la sola chiave
-- normalizzata ambigua:
--     'stazione scrovegni c so del popolo fiera cittadella'
-- che oggi punta erroneamente a 'centro-storico' pur citando Fiera
-- (est-brenta). Dopo la rimozione il resolver restituisce NULL (fail-closed).
--
-- NON TOCCA: 'stazione', 'stazione ferroviaria', 'scrovegni', 'fiera',
-- civiko_commercial_zones, workspace, prenotazioni/trial, profili, listing,
-- segnali. Nessun backfill. Nessuna zona cancellata, rinominata o fusa.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_key      text := 'stazione scrovegni c so del popolo fiera cittadella';
  v_count    integer;
  v_slug     text;
BEGIN
  -- Precondizione 1: esiste esattamente una riga con quella chiave.
  SELECT count(*) INTO v_count
  FROM public.civiko_quartiere_commercial_zone_map
  WHERE quartiere_key = v_key;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'ABORT: attesa esattamente 1 riga per %, trovate %', v_key, v_count;
  END IF;

  -- Precondizione 2: oggi punta a centro-storico.
  SELECT commercial_zone_slug INTO v_slug
  FROM public.civiko_quartiere_commercial_zone_map
  WHERE quartiere_key = v_key;

  IF v_slug IS DISTINCT FROM 'centro-storico' THEN
    RAISE EXCEPTION
      'ABORT: atteso commercial_zone_slug = centro-storico per %, trovato %',
      v_key, coalesce(v_slug, 'NULL');
  END IF;

  -- Azione: rimuove esclusivamente quella riga.
  DELETE FROM public.civiko_quartiere_commercial_zone_map
  WHERE quartiere_key = v_key;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'ABORT: delete ha rimosso % righe invece di 1', v_count;
  END IF;

  -- Postcondizione: le chiavi non ambigue restano intatte.
  SELECT count(*) INTO v_count
  FROM public.civiko_quartiere_commercial_zone_map
  WHERE quartiere_key IN ('stazione', 'stazione ferroviaria', 'scrovegni')
    AND commercial_zone_slug = 'centro-storico';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'ABORT: chiavi Stazione/Scrovegni non piu mappate a centro-storico';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- ROLLBACK ESATTO (reinserimento della sola riga originaria):
--
-- BEGIN;
-- INSERT INTO public.civiko_quartiere_commercial_zone_map
--   (quartiere_key, commercial_zone_slug)
-- VALUES
--   ('stazione scrovegni c so del popolo fiera cittadella', 'centro-storico');
-- COMMIT;
--
-- (Se la tabella ha colonne aggiuntive con default, il rollback le ripristina
--  ai default: la riga originaria non conteneva altri valori significativi.)
-- ============================================================================
