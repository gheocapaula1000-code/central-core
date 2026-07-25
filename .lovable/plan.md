
# Piano tecnico — `civiko-signals-classify` + `civiko-property-signals-match`

Nessuna riga di codice, nessuna migration eseguita. Solo design da approvare.

---

## Parte A — `civiko-signals-classify`

### A1. Source tables (6, non 5)

Il classificatore è l'aggregatore normalizzatore. Le sorgenti reali oggi popolate sono 6 (radar/territorial/inheritance/legal_life/early_offmarket + local_signals come L1–L3 manuale). Le due tabelle "signal" attualmente vuote (`turnover_signals`, `legal_property_signals`) restano in scope, così quando arriveranno dati verranno classificate automaticamente. `listing_velocity_signals` e `pricing_error_signals` sono aggregatori derivati e restano fuori (già "usable_for_scoring" a valle).

| Source table | Testo/descrizione | Geo (quartiere / lat-lng) | signal_type mappato |
|---|---|---|---|
| `radar_signals` | `title` + `description` | `municipality`, `lat`,`lng` | valore già in `signal_type` |
| `territorial_signals` | `title` + `description` | `municipality`, `lat`,`lng` | `signal_type` (fallback `urbanistica`/`mobilita` da `signal_subtype`) |
| `inheritance_pressure_signals` | `area_label` + `indicators` jsonb | `comune`,`area_label`,`lat`,`lng` | fisso `inheritance_pressure` |
| `legal_life_event_signals` | `explanation` + `property_hint` | `municipality`,`area_or_microzone` (no lat/lng) | fisso `legal_distress` |
| `legal_property_signals` (oggi 0) | `payload.description` + `estimated_asset_type` | `comune`,`lat`,`lng` | fisso `legal_distress` |
| `turnover_signals` (oggi 0) | `payload` | `comune` | fisso `estate_turnover` |
| `early_offmarket_signal_candidates` (SOLO `status='approved'`) | `summary` + `why_it_matters` + `ai_summary` | `comune`, `quartiere` (no lat/lng) | derivato da `signal_type` con normalizzazione a policy keys |
| `local_signals` (L1–L3, `is_active=true`) | `title` + `summary` | `municipality`,`neighborhood`,`lat`,`lng`,`radius_meters` | derivato da `source_level` → `local_buzz` (L3) / `omi`-`istat`-`urbanistica`-`mobilita` (L1/L2 via `category`) |

### A2. Mapping su `classifySignal()` — firma richiesta

La libreria `_shared/civikoSignalClassification.ts` accetta:

```
classifySignal({
  signal_id: string,
  signal_type: string,
  source_name_internal: string,
  collected_at?: string,
  confidence_level?: "alta"|"media"|"bassa",
  allowed_commercial_phrase?: string|null,
  override?: Partial<SignalPolicyDefaults>
})
```

Mapping per sorgente:

- `signal_id` = **`"<source_table>:<id>"`** (stringa, canonica di dedup a valle).
- `source_name_internal` = valore reale (`source_name`, `source`, o `source_names[0]`). Rimane nel Core, mai esposto alla PWA.
- `confidence_level` — normalizzazione:
  - stringa `alta|media|bassa` → passthrough (radar/legal_life)
  - numerico `confidence_score` (0–1) → `>=0.8 alta`, `>=0.5 media`, altrimenti `bassa` (inheritance/legal_property/early_offmarket/territorial/turnover)
  - `local_signals.confidence` (text) → passthrough
- `allowed_commercial_phrase` — costruita nel classifier con template deterministici per `signal_type` (nessuna free-text arbitraria dalla source). Esempi:
  - `inheritance_pressure` → `"Zona con dinamiche di ricambio proprietario elevate"`
  - `legal_distress` → `"Procedura patrimoniale nell'area, opportunità di riferimento OMI"`
  - `omi`/`urbanistica`/`mobilita` → riusa `title` sanitizzato dalla lib.
- `collected_at` — first non-null tra `detected_at | fetched_at | computed_at | created_at`.
- `override` = **non usato** nel primo giro. La policy viene dal DB (vedi A5).

**Campi mancanti dichiarati esplicitamente:**
- `legal_life_event_signals` non ha `lat/lng` → resta senza geo puntuale (solo `area_or_microzone`), il matcher lo tratta come "zona-only".
- `early_offmarket_signal_candidates` non ha `lat/lng` → idem, geo per `quartiere`+`comune`.
- `turnover_signals` (schema attuale) espone solo `comune`/`provincia`, geo aggregata.

### A3. Schema upsert su `civiko_signals_classified`

Chiave di deduplica: **`signal_id`** (già text). Serve indice UNIQUE (vedi A7 — migration).

Campi scritti a ogni upsert:
- `signal_id`, `signal_type`, `source_name_internal`, `collected_at`
- `confidence_level`, `sensitivity_level`, `usable_for_scoring`, `visible_to_agency`, `visible_to_owner`
- `allowed_commercial_phrase`, `forbidden_phrases` (ARRAY), `retention_policy`
- `payload` jsonb minimo: `{ source_table, source_id, municipality, quartiere, lat, lng, evidence_url? }` (sanitizzato, mai PII / mai `payload` grezzo di source)
- `updated_at = now()` via trigger già presente

Regola tassativa: **niente** description grezza. Solo `allowed_commercial_phrase`. Le fonti sensibili (`inheritance_pressure`, `legal_distress`, `estate_turnover`, `motivated_seller`) vengono comunque scritte ma con `visible_to_agency=false`, `visible_to_owner=false` — restano Core-only per scoring.

### A4. Idempotenza, batching, paginazione

- Idempotenza garantita da `ON CONFLICT (signal_id) DO UPDATE`.
- Batch: **500 righe per source per run**, ordinate per `updated_at ASC` con cursor (`updated_at > last_seen_cursor`).
- Cursor persistito in nuova riga `pipeline_runs` (già esistente) con `job_name='civiko-signals-classify'` e `metadata.cursor_by_source`.
- Per-source watermark separato per evitare che una source lenta blocchi le altre.

### A5. Uso di `civiko_signal_policy`

- La tabella è **oggi vuota** — la lib usa i default hardcoded (`POLICY_DEFAULTS` in `_shared/civikoSignalClassification.ts`).
- Strategia: **carica una volta all'avvio del job** (`SELECT * FROM civiko_signal_policy`), merge con i default, poi passa `override` a `classifySignal()` per i `signal_type` che hanno override in DB.
- Costo: 1 query, ~20 righe max attese.
- Se in futuro la tabella cambia mid-run, non ricarichiamo: le modifiche entreranno al run successivo (accettabile per un job nightly).

### A6. Auth, timeout, dipendenze

- `verify_jwt = false` in `supabase/config.toml`, protezione via header **`x-job-secret`** confrontato con `AI_CORE_SECRET` in constant-time (stesso pattern degli altri cron interni).
- Endpoint: `POST /functions/v1/civiko-signals-classify` con body `{ dry_run?: bool, sources?: string[], limit_per_source?: number }`.
- Timeout stimato: ~15–30s per un run "steady" (delta) con 7 sorgenti × 500 righe = 3.500 upsert. Primo run (backfill totale, ~1.100 righe attive) < 10s.
- Dipendenze: `civiko_signal_policy` (opzionale), tutte le 7 source tables in read, `civiko_signals_classified` in write, `pipeline_runs` per cursore.

---

## Parte B — `civiko-property-signals-match`

### B1. Regola di match segnale ↔ `padova_listings`

Match multilivello, applicato in cascata (il primo che matcha vince, il metodo viene salvato in `match_reason`):

1. **Puntuale** (`match_reason='geo_radius_300m'`): se il segnale ha `lat/lng` validi e il listing ha `lat/lng` → Haversine ≤ **300 m** (default).
2. **Fallback zona commerciale** (`match_reason='commercial_zone'`): il segnale è geolocalizzato nel poligono di una `civiko_commercial_zones` → match con listings dove `padova_listings.commercial_zone_slug` coincide.
3. **Fallback quartiere** (`match_reason='quartiere_canon'`): il segnale ha `neighborhood`/`area_label`/`quartiere` normalizzabile via `quartiere_canon_map` → match sui listings dello stesso quartiere.
4. **Comune-wide** (`match_reason='municipality'`): solo per segnali `territorial`/`estate_turnover` a scala comunale, marcati con `relevance_score` basso e **non** promossi al report proprietario.

Il raggio 300 m è configurabile via body `radius_meters` (min 50, max 1500).

### B2. Cosa scriviamo in `property_signal_matches`

Schema **già presente**, i campi opzionali sono coerenti col design:

| colonna | valore |
|---|---|
| `property_id` (text) | id opaco del listing (vedi B7 — migration) |
| `signal_id` (bigint) | **PROBLEMA**: oggi è `bigint`, ma il classifier usa `signal_id` text (`<table>:<id>`). Vedi B7. |
| `distance_meters` | valore Haversine se metodo 1; null altrimenti |
| `relevance_score` | 0.0–1.0 (vedi formula sotto) |
| `match_reason` | uno dei 4 valori sopra |
| `recommended_use` | copiato da `civiko_signals_classified.allowed_commercial_phrase` |
| `visible_in_owner_report` | copiato da `civiko_signals_classified.visible_to_owner` |
| `created_at` | now() |

Formula `relevance_score` (deterministica, no ML):
```
score = w_confidence * f(confidence_level)   // 0.4 max
      + w_geo * f(match_reason)              // 0.4 max (radius=1.0, zone=0.7, quartiere=0.5, muni=0.2)
      + w_sensitivity * f(sensitivity_level) // 0.2 max (alto vale di più per scoring interno)
```

### B3. Ordine di esecuzione

Dipendenza dura: **`civiko-signals-classify` deve girare prima**. Il matcher legge **solo** `civiko_signals_classified` (non le source), così eredita policy e sanitizzazione. Schedulazione consigliata: matcher parte 30 min dopo il classifier.

### B4. Top-K o tutti

- **Tutti** i match che superano `relevance_score ≥ 0.35` (soglia configurabile).
- Cap difensivo: max **20 segnali per property** (top-K per `relevance_score`), per evitare bloat sulla PWA e report proprietario troppo lunghi.
- I match sotto soglia non vengono scritti (non "salvati e nascosti") — meglio assente che fragile.

### B5. Idempotenza

- Serve UNIQUE `(property_id, signal_id)` — **oggi assente**, vedi B7.
- `ON CONFLICT (property_id, signal_id) DO UPDATE` di `distance_meters`, `relevance_score`, `match_reason`, `recommended_use`, `visible_in_owner_report`.
- I match "orfani" (signal ora non più attivo o listing scaduto) vengono cancellati con una `DELETE` conservativa a fine run (WHERE property_id IN (batch) AND signal_id NOT IN (validi)).

### B6. Batching e timeout stimato

Numeri reali: **8.307 listings** × **~1.100 segnali classificati attesi**.

- Naïve cross-join = 9.1M coppie → impraticabile.
- Strategia: **partiziona per `commercial_zone_slug`** (8 zone Padova). Per ogni zona:
  1. Carica listings della zona (avg ~1.000)
  2. Carica signals classificati la cui geo cade nella zona (avg ~150)
  3. Cross-join in memoria (~150k coppie per zona) con filtro Haversine ≤ 300 m
  4. Upsert batch da 500 righe
- Timeout stimato per run steady (delta signals ultime 24h, ~50 signals nuovi): **10–20 s** end-to-end.
- Full rebuild (`rebuild=true`): stimato **60–90 s**. Sopra il limite edge (150s) siamo comunque al sicuro; se peggiora → self-chaining per zona (pattern già usato in `earlyOffmarketRunner`).

Auth identica al classifier: `verify_jwt=false` + `x-job-secret`.

---

## Parte C — Migration necessarie (SEPARATE dal codice, da approvare a parte)

### C1. `civiko_signals_classified` — indice unico

```sql
CREATE UNIQUE INDEX IF NOT EXISTS civiko_signals_classified_signal_id_uq
  ON public.civiko_signals_classified (signal_id);
```
Motivazione: dedup upsert. Oggi c'è solo indice non-unique su `signal_type`.

### C2. `property_signal_matches` — cambio tipo `signal_id` + unique

Problema di design: `property_signal_matches.signal_id` è `bigint` (era pensato per FK numerica), ma il classifier emette `signal_id` **text** (`radar_signals:123`, `local_signals:45`, etc.) per unificare source diverse. Due opzioni:

- **Opzione 1 (consigliata)**: cambiare `signal_id` a **text** e allinearlo a `civiko_signals_classified.signal_id`.
- **Opzione 2**: aggiungere `signal_id_text text` accanto al bigint. Sconsigliata (schema sporco).

Migration consigliata (Opzione 1):
```sql
ALTER TABLE public.property_signal_matches
  ALTER COLUMN signal_id TYPE text USING signal_id::text;

CREATE UNIQUE INDEX IF NOT EXISTS property_signal_matches_property_signal_uq
  ON public.property_signal_matches (property_id, signal_id);

CREATE INDEX IF NOT EXISTS property_signal_matches_signal_idx
  ON public.property_signal_matches (signal_id);
```

### C3. `padova_listings.property_id` opaco

`padova_listings.id` è `bigint`. Il contratto storico (`docs/CIVIKO_HYPERLOCAL_SIGNALS.md`) richiede un `property_id` **opaco** stabile per non esporre id interni alla PWA. Opzioni:

- **Opzione A** (minimo): usare `md5('padova_listings:' || id)` come `property_id` derivato al volo, senza colonna.
- **Opzione B** (pulito): aggiungere colonna `property_id_opaque text GENERATED ALWAYS AS (encode(...))` + indice.

Consigliata **A** per ora (nessun cambio schema, coerente con `property_id_registry` già esistente).

### C4. Indici geo/zona per il matcher

```sql
CREATE INDEX IF NOT EXISTS padova_listings_zone_expired_idx
  ON public.padova_listings (commercial_zone_slug)
  WHERE expired_at IS NULL;

CREATE INDEX IF NOT EXISTS civiko_signals_classified_collected_idx
  ON public.civiko_signals_classified (collected_at DESC);
```
(Il primo può già esistere — verifico prima di scrivere la migration.)

---

## Schema tabelle target — come sono OGGI

### `civiko_signals_classified`
```
id bigserial PK
signal_id text                    -- oggi NON unique, va aggiunto
signal_type text
source_name_internal text
collected_at timestamptz
confidence_level text             -- alta|media|bassa
sensitivity_level text            -- basso|medio|alto|escluso
usable_for_scoring bool
visible_to_agency bool
visible_to_owner bool
allowed_commercial_phrase text
forbidden_phrases text[]
retention_policy text             -- 30d|90d|180d|365d|permanent
payload jsonb
created_at timestamptz
updated_at timestamptz            -- trigger già presente
```
Indici oggi: `idx_csc_signal_type`, `idx_csc_sensitivity`, `idx_csc_collected_at`.
RLS: attiva (service_role full), 0 righe pubbliche.

### `property_signal_matches`
```
id bigserial PK
property_id text
signal_id bigint                  -- da migrare a text (vedi C2)
distance_meters numeric
relevance_score numeric
match_reason text
recommended_use text
visible_in_owner_report bool
created_at timestamptz
```
Indici oggi: `idx_psm_property (property_id)`, `idx_psm_signal (signal_id)`. Nessun UNIQUE.

---

## Sintesi decisioni da confermare

1. **Sorgenti**: 7 tabelle come sopra (incluse le due oggi vuote, per non riscrivere quando si popolano). OK/no?
2. **Formato `signal_id`**: `"<source_table>:<id>"` text. OK/no?
3. **Migration C2**: cambio `property_signal_matches.signal_id` da bigint a text. Rischi zero (tabella vuota). OK/no?
4. **`property_id` opaco**: derivato via `md5('padova_listings:'||id)` senza nuova colonna. OK/no?
5. **Raggio default matcher**: 300 m. OK/no?
6. **Soglia `relevance_score` min**: 0.35, cap 20/property. OK/no?
7. **`civiko_signal_policy` vuota**: uso i default della libreria, override DB opzionale. OK/no?

Su conferma di questi 7 punti procedo con: (i) migration `C1+C2+C4`, (ii) edge function `civiko-signals-classify`, (iii) edge function `civiko-property-signals-match`, (iv) 2 cron jobs (classifier `4:45 UTC`, matcher `5:15 UTC`). Ogni passo separato e reversibile.
