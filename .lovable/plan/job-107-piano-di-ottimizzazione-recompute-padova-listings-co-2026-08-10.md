# Job 107 — Piano di ottimizzazione `recompute_padova_listings_contendibili`

Obiettivo: portare il run da ~124 s a 30-40 s, senza cancellare dati e senza toccare altre tabelle.
Radice del problema: `civiko_padova_matcher_v4_candidates()` ricalcola a ogni run, per ogni annuncio attivo (~2.700 righe), funzioni costose su `raw_json` (detoasting + regex + estrazioni JSON): tipologia, canonical id, asta, MLS, chiave agenzia.

## 1. Colonne derivate persistite su `padova_listings`

Si aggiungono 5 colonne nuove, tutte nullable, nessuna colonna esistente viene modificata o rimossa. Si segue la convenzione `ev_*` già presente (`ev_via_norm`, `ev_civico_norm`, `ev_piano_key`, `ev_descr_fp`).

```sql
ALTER TABLE public.padova_listings
  ADD COLUMN IF NOT EXISTS ev_tipologia            text,
  ADD COLUMN IF NOT EXISTS ev_canonical_listing_id text,
  ADD COLUMN IF NOT EXISTS ev_is_asta              boolean,
  ADD COLUMN IF NOT EXISTS ev_is_mls               boolean,
  ADD COLUMN IF NOT EXISTS ev_agency_key           text,
  ADD COLUMN IF NOT EXISTS ev_flags_at             timestamptz;
```

Indici di supporto (creati dopo il backfill, uno per volta):

```sql
CREATE INDEX IF NOT EXISTS padova_listings_ev_canonical_idx
  ON public.padova_listings (ev_canonical_listing_id)
  WHERE expired_at IS NULL;

CREATE INDEX IF NOT EXISTS padova_listings_recompute_scope_idx
  ON public.padova_listings (commercial_zone_slug, ev_agency_key)
  WHERE expired_at IS NULL;

-- individua rapidamente le righe ancora da backfillare / ricalcolare
CREATE INDEX IF NOT EXISTS padova_listings_ev_flags_todo_idx
  ON public.padova_listings (id)
  WHERE ev_flags_at IS NULL;
```

Semantica: `ev_flags_at` marca quando le 5 colonne sono state calcolate. `NULL` = da (ri)calcolare.

## 2. Trigger su INSERT/UPDATE

Il trigger calcola le stesse espressioni oggi presenti nel matcher, solo quando cambiano gli input rilevanti (`raw_json`, `url`, `fonte`, `agency`). Nessuna scrittura su altre tabelle, nessun `DELETE`.

```sql
CREATE OR REPLACE FUNCTION public.padova_listings_ev_flags_trg()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.raw_json IS NOT DISTINCT FROM OLD.raw_json
     AND NEW.url      IS NOT DISTINCT FROM OLD.url
     AND NEW.fonte    IS NOT DISTINCT FROM OLD.fonte
     AND NEW.agency   IS NOT DISTINCT FROM OLD.agency
     AND OLD.ev_flags_at IS NOT NULL
  THEN
    RETURN NEW;  -- niente da ricalcolare
  END IF;

  NEW.ev_tipologia            := public.padova_unit_tipologia(NEW.raw_json);
  NEW.ev_canonical_listing_id := public.padova_listing_canonical_id(NEW.url, NEW.fonte);
  NEW.ev_is_asta              := public.padova_listing_has_auction_evidence(NEW.raw_json, NEW.agency);
  NEW.ev_is_mls               := public.padova_listing_has_mls_exclusive_evidence(NEW.raw_json);
  NEW.ev_agency_key           := COALESCE(
      NULLIF(public.norm_agency(regexp_replace(lower(trim(NEW.agency)),
             '^(agenzia immobiliare|immobiliare)\s+', '', 'g')), ''),
      public.norm_agency(NEW.agency));
  NEW.ev_flags_at             := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER padova_listings_ev_flags_trg
BEFORE INSERT OR UPDATE OF raw_json, url, fonte, agency
ON public.padova_listings
FOR EACH ROW EXECUTE FUNCTION public.padova_listings_ev_flags_trg();
```

Il trigger è `BEFORE ... FOR EACH ROW` e scrive solo su campi `NEW`: non genera scritture aggiuntive né ricorsione. Convive senza conflitti con `civiko_padova_listings_zone_trg` (colonne disgiunte).

## 3. Backfill a batch (500 righe per volta)

Eseguito in transazioni separate, una per batch, così da non tenere lock lunghi. Solo `UPDATE` di colonne nuove, mai `DELETE`.

```sql
-- da ripetere finché updated = 0
WITH todo AS (
  SELECT id FROM public.padova_listings
   WHERE ev_flags_at IS NULL
   ORDER BY id
   LIMIT 500
   FOR UPDATE SKIP LOCKED
)
UPDATE public.padova_listings p
   SET ev_tipologia            = public.padova_unit_tipologia(p.raw_json),
       ev_canonical_listing_id = public.padova_listing_canonical_id(p.url, p.fonte),
       ev_is_asta              = public.padova_listing_has_auction_evidence(p.raw_json, p.agency),
       ev_is_mls               = public.padova_listing_has_mls_exclusive_evidence(p.raw_json),
       ev_agency_key           = COALESCE(
           NULLIF(public.norm_agency(regexp_replace(lower(trim(p.agency)),
                  '^(agenzia immobiliare|immobiliare)\s+', '', 'g')), ''),
           public.norm_agency(p.agency)),
       ev_flags_at             = now()
  FROM todo
 WHERE p.id = todo.id;
```

Ordine di esecuzione: prima gli attivi (`expired_at IS NULL`), poi lo storico. Il backfill è riavviabile e idempotente: un batch interrotto lascia semplicemente `ev_flags_at NULL` e verrà ripreso.

## 4. Materializzazione unica dei candidati

Dentro `recompute_padova_listings_contendibili()`, il set base viene calcolato una sola volta:

```sql
CREATE TEMP TABLE tmp_cand ON COMMIT DROP AS
SELECT * FROM public.civiko_padova_matcher_v4_candidates();
CREATE INDEX ON tmp_cand (identity_key);
CREATE INDEX ON tmp_cand (canonical_listing_id);
ANALYZE tmp_cand;
```

Tutte le fasi successive (coppie, cluster Haversine 50 m, cap prezzo 8 %, classificazione "Contesi 3+") leggono da `tmp_cand` invece di richiamare il matcher più volte.

## 5. Matcher che legge le colonne già calcolate

`civiko_padova_matcher_v4_candidates()` viene riscritto sostituendo le chiamate costose con le colonne persistite, con fallback per righe non ancora backfillate:

```sql
COALESCE(p.ev_tipologia,            public.padova_unit_tipologia(p.raw_json))              AS tipologia,
COALESCE(p.ev_canonical_listing_id, public.padova_listing_canonical_id(p.url, p.fonte))    AS canonical_listing_id,
COALESCE(p.ev_is_asta,  public.padova_listing_has_auction_evidence(p.raw_json, p.agency))  AS is_asta,
COALESCE(p.ev_is_mls,   public.padova_listing_has_mls_exclusive_evidence(p.raw_json))      AS is_mls,
COALESCE(p.ev_agency_key, public.norm_agency(p.agency))                                    AS agency_key,
```

Logica, filtri, soglie e output restano identici byte per byte: cambia solo la provenienza dei valori. Al termine del backfill i `COALESCE` non toccano più `raw_json` per le righe attive, eliminando il detoasting.

Nota: `title_type_ok` e `descr_fp` restano come oggi (leggono `raw_json`/`ev_descr_fp`); se il tempo residuo lo richiede si valuterà `ev_title_type_ok` in un secondo passo, non in questo intervento.

## 6. Rete di sicurezza — timeout del solo job 107

Solo dopo aver verificato il nuovo tempo, e solo come protezione temporanea:

```sql
SELECT cron.alter_job(107, command := $c$ SELECT set_config('statement_timeout','600s',true);
  SELECT public.recompute_padova_listings_contendibili(); $c$);
```

Applicato al solo job 107, senza modificare il timeout globale né altri job.

## Ordine di esecuzione e verifiche

1. Migration A: colonne + trigger (nessun backfill) — impatto nullo sui run esistenti.
2. Backfill a batch fino a `ev_flags_at IS NULL` = 0 sugli attivi.
3. Migration B: indici.
4. Migration C: matcher aggiornato + temp table nella funzione di recompute.
5. Esecuzione manuale cronometrata di `recompute_padova_listings_contendibili()` e confronto conteggi contendibili/coppie **prima vs dopo** (devono coincidere).
6. Solo se il tempo resta > 60 s: step 6 (timeout 600 s sul job 107).

## Garanzie sui dati

- Nessun `DELETE`, `DROP TABLE`, `TRUNCATE` in nessuno step.
- Solo `ADD COLUMN` nullable: le righe esistenti non cambiano valore su nessun campo attuale.
- Il backfill scrive esclusivamente sulle 6 colonne nuove.
- Rollback semplice: `DROP TRIGGER` + `ALTER TABLE ... DROP COLUMN ev_*` riporta esattamente allo stato attuale; il matcher precedente è ripristinabile da migration inversa.
- Nessuna tabella diversa da `padova_listings` viene toccata; il job 114 e gli altri cron restano invariati.
