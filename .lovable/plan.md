## Obiettivo

Aggiungere in modo **production-safe** le prossime fonti dati Padova (P1: F4 anziani, F3/F20 mobilità ISTAT, F12 borsino, F18 SUE; P2: F15 conservatoria gated, F22 separazioni aggregate, F17 APE labeling), con compliance, attribution e nessun dato personale verso la PWA.

Lo lavoro è grosso: serve approvazione per piano e migrazione DB **prima** di scrivere codice. Una volta approvato, eseguo tutto in un'unica passata.

---

## 1. Schema DB (un'unica migrazione)

Nuove tabelle nello schema `public`, tutte con GRANT espliciti e RLS.

### 1.1 `civiko_source_registry` (registry unificato)

Colonne: `id`, `source_code` (UNIQUE, es. `F4`), `source_name`, `source_url`, `refresh_frequency`, `access_type` (enum: `public_api|public_file|scraping|paid_gateway|manual_import`), `compliance_level` (enum: `public|sensitive_aggregate|sensitive_restricted`), `implementation_status` (enum: `live|partial|manual_import|planned|disabled`), `last_success_at`, `last_error`, `record_count`, `notes`, `created_at`, `updated_at`.

RLS: SELECT solo admin (`has_role(auth.uid(),'admin')`); scrittura solo service_role. GRANT a `authenticated` + `service_role`, no `anon`.

Seed iniziale: 7 righe (F3, F4, F12, F15, F17, F18, F20, F22) con stato corretto (`planned`/`manual_import`/`partial`).

### 1.2 `padova_elderly_population` (F4)
Aggregato per quartiere/microzona. Campi: `year`, `area_name`, `area_code`, `over_65_count`, `over_75_count`, `total_population`, `over_75_rate` (generated), `source_url`, `imported_at`. UNIQUE (`year`, `area_name`). RLS: read admin/service; nessun campo persona.

### 1.3 `istat_apr4_mobility` (F3/F20)
Aggregato per comune/anno. Campi: `year`, `comune`, `comune_istat`, `iscritti`, `cancellati`, `saldo_migratorio`, `transfer_rate` (nullable), `source_url`, `imported_at`. UNIQUE (`year`, `comune_istat`).

### 1.4 `market_benchmark_padova` (F12)
Cross-check OMI. Campi: `period`, `area_name`, `min_price_eur_mq`, `max_price_eur_mq`, `avg_price_eur_mq`, `rent_eur_mq_month`, `source_name`, `source_url`, `imported_at`. UNIQUE (`period`, `area_name`, `source_name`).

### 1.5 `sue_padova_permits` (F18)
Solo dati pubblici lawful. Campi: `area_name`, `address_public` (nullable, solo se già pubblico), `practice_type`, `practice_date`, `status`, `source_url`, `imported_at`, `compliance_verified` (boolean, default false → riga nascosta).

### 1.6 `istat_separations_padova` (F22)
Solo aggregato. Campi: `year`, `comune`, `comune_istat`, `separations_count`, `divorces_count`, `marriages_count`, `separation_rate`, `divorce_rate`, `source_url`, `imported_at`. UNIQUE (`year`, `comune_istat`).

### 1.7 `restricted_report_audit` (F15 gate)
Cost ledger + audit per accessi paid OpenAPI.it conservatoria. Campi: `user_id`, `agency_id`, `feature_code` (`F15_CONSERVATORIA`), `target_ref` (hash, non PII raw), `cost_cents`, `provider`, `provider_response_id`, `requested_at`, `status`. RLS: utente vede solo i propri; admin tutti.

**Nessuna tabella per dati persona da F15.** Il payload restituito dal flusso paid viene reso ephemeral (response only) o cifrato in `restricted_reports` con scadenza e accesso autorizzato. Per ora la tabella di audit basta — l'archiviazione del contenuto la affronto solo quando il workflow paid sarà davvero attivato (oggi: gate chiuso).

---

## 2. Edge Functions

### 2.1 Nuova: `civiko-source-registry`
- `GET /sources` → lista pubblica admin-only (dietro auth) di tutte le righe registry.
- `POST /import/elderly-population` (F4) — admin only, accetta CSV (upload o body) → normalizza → `padova_elderly_population` + aggiorna registry.
- `POST /import/apr4-mobility` (F3/F20) — admin only, CSV o pull diretto da demo.istat.it se possibile (HTTP, no auth).
- `POST /import/market-benchmark` (F12) — admin only, CSV manuale (Borsino/FIAIP non hanno API libere).
- `POST /import/sue-permits` (F18) — admin only, CSV con `compliance_verified=true` solo se l'admin conferma la fonte pubblica.
- `POST /import/separations` (F22) — admin only, CSV ISTAT aggregato.

Auth: `Authorization: Bearer <JWT admin>` + check `has_role`. CORS: usa `_shared/http.ts`. CSV via `csv-imports` bucket esistente.

### 2.2 Nuova: `civiko-restricted-report` (F15 paid gate)
- `POST /conservatoria/request` — richiede:
  - feature flag attivo (env `F15_CONSERVATORIA_ENABLED=true`)
  - JWT utente autenticato
  - parametro `acknowledged_cost: true`
  - agency con billing attivo
- Logga in `restricted_report_audit` PRIMA di chiamare OpenAPI.it.
- Se env mancante o flag off → `403 FEATURE_NOT_ENABLED`. **Nessuna mass scan**.
- Output: report nel response (no persistenza dati persona) + `audit_id`.

### 2.3 Estensione `connector-status`
Aggiungo blocco `sources` che query-a `civiko_source_registry` e ritorna `source_code`, `status`, `last_success_at`, `record_count`, `last_error`, `next_refresh_hint`. Admin-only.

### 2.4 Estensione scoring (`civiko-opportunity-engine` o nuovo `civiko-zone-scoring`)
Aggiungo helper `buildScoreContributions(zoneId)` che combina:
- elderly (`F4`) → weight 0.20, confidence dipende da freshness
- APR4 (`F3/F20`) → weight 0.20
- benchmark (`F12`) → weight 0.15 (cross-check OMI)
- SUE (`F18`) → weight 0.15
- separations (`F22`) → weight 0.05 (weak)

Ogni contributo include `{source_code, value, confidence, last_updated, explanation}`. Niente score senza attribution.

### 2.5 F17 APE labeling
Update output del provider esistente (Veneto APE estimate) per allegare:
```
{ value: "C", source: "ai_estimate", official_source_status: "planned",
  disclaimer: "Classe energetica stimata, non sostituisce APE ufficiale." }
```
Aggiorno la riga `F17` in registry con `implementation_status='partial'`.

---

## 3. Compliance guard

`_shared/compliance.ts` con:
- `assertAggregateOnly(rec)` per gli importer sensibili (separations, mobility) — rigetta righe con campi persona.
- `redactSensitiveForPwa(payload)` che strippa qualsiasi campo flaggato `sensitive_restricted` prima di tornare al frontend.
- Registry-driven: ogni payload PWA passa attraverso un filtro che blocca `compliance_level='sensitive_restricted'`.

---

## 4. Frontend (minimo)

Solo admin: aggiungo una pagina `src/pages/SourceRegistryPage.tsx` con tabella read-only dei sources + stato. Linkata in `AdminSidebar`. Niente UI consumer.

---

## 5. Tests (vitest)

Nuovi file in `src/test/`:
- `source-registry.test.ts` — validazione enum, shape, presenza F-codes attesi.
- `import-normalization.test.ts` — CSV → record corretto, no persona.
- `compliance-redaction.test.ts` — `redactSensitiveForPwa` rimuove restricted, mantiene aggregate.
- `scoring-attribution.test.ts` — ogni contributo ha `source_code`, niente black-box.
- `restricted-report-gate.test.ts` — `F15` 403 senza flag, audit log scritto prima della call.

Esistenti (950) devono restare verdi.

---

## 6. Documentazione

`docs/civiko-padova-data-sources.md`: tabella registry + flusso import + compliance note + workflow F15.

---

## 7. Ordine esecuzione

1. **Approvazione di questo piano** ←
2. Migrazione DB (1.1–1.7) → richiede tua approvazione separata.
3. Codice edge functions + shared helpers + frontend admin + test in un singolo commit.
4. Verifica `tsc`, `vitest`, `eslint`.

---

## Cose che NON faccio

- ❌ Scraping Sister/conservatoria diretto.
- ❌ Tabelle/output con dati persona (eredi, separazioni nominative, proprietari).
- ❌ Mass-scan F15: ogni chiamata è singola + auditata + costata.
- ❌ Sostituire OMI con F12 (cross-check, non baseline).
- ❌ Cambiare Supabase project ID, contratti API esistenti, billing.
- ❌ Esporre `MAPBOX_API_KEY`/secrets al frontend.

Confermi il piano? Se sì, proseguo creando la migrazione DB (avrai un secondo approval step) e poi il codice.
