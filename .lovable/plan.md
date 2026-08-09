# Diagnosi read-only — radar_signals vs /agent-radar e cron-radar-padova-nightly

Nessun file, database, secret o progetto è stato modificato. Solo letture (codice + query SELECT).

## 1) /civiko-radar-veneto/agent-radar scrive su radar_signals?

No. È un percorso **esclusivamente in lettura**.

- `supabase/functions/civiko-radar-veneto/agentRadar.ts`: tutte le occorrenze di `radar_signals` sono `select` (righe 441-455, 1193, 1291). Nel file non esiste alcun `insert`, `upsert` o `rpc` di scrittura.
- `supabase/functions/civiko-radar-veneto/index.ts`, ramo `pathname.endsWith("/agent-radar")` (righe ~3138-3646): nel blocco non c'è nessuna scrittura su `radar_signals`. Le uniche RPC nell'intervallo sono `recompute_padova_contendibili`, `recompute_padova_contendibili_extras` e `padova_omi_snapshot_breakdown` (read/recompute su altre tabelle).

Le scritture reali su `radar_signals` vivono altrove:
- `civiko-radar-veneto/deriveSignals.ts` → `deriveAllSignals()` insert su `radar_signals` (riga 310), invocata **solo** da `/jobs/activate-veneto` (`index.ts` righe 931 / 1178).
- `civiko-radar-veneto/advancedOpportunity.ts:721` (upsert `onConflict: fingerprint`) — job `/jobs/build-advanced-veneto-opportunities`.
- `civiko-radar-veneto/firecrawl/microzoneOpportunityRunner.ts:235` — job firecrawl microzone.
- `civiko-radar-veneto/offmarket/earlyOffmarketRunner.ts`, `openData/*`, `dataEngine.ts`, `agency/agencyOffmarketBrief.ts`, `civiko-signals-classify`, `sottra/scan.ts`.

Conclusione: `agent-radar` deve **leggere e restituire opportunità/zone**, non produrre `radar_signals`.

## 2) Query che producono i candidati Padova e filtri che li azzerano

In `agentRadar.ts` (funzione di pull, righe 412-510) le fonti sono:
- `listing_price_snapshots` — finestra `captured_at >= now()-60d`, filtro `province in (PD, Padova)`
- `motivated_sellers` — `is_active = true` + provincia
- `market_anomalies` — `is_active = true` + provincia
- `radar_signals` — `is_active = true` + provincia + `ilike municipality`
- `omi_valori` — `regione ilike Veneto`, `compr_max not null`
- `auction_signals` — `is_active = true`
- `area_opportunity_scores` — `province = PD`
- `territorial_signals` — `is_active = true`

Filtri a valle che possono portare a **zero** (in `index.ts`, ramo agent-radar, righe ~3519-3575):
- `isPadova(o.comune)`: scarta tutto ciò che non ha `comune === "padova"` (contatore `excluded_out_of_scope`);
- `requireOmiZoneAR` (attivo con `require_omi_zone` o `scope=padova_omi_zones`): scarta ogni opportunità senza `omi_zone_code` (`excludedNoOmiZoneAR`) e con `omi_zone_confidence < 0.6` (`excludedLowConfidenceAR`), via `resolvePadovaOmiBatch` che richiede `lat`/`lng`.

Quindi un candidato può esistere ma sparire per: comune non normalizzato, coordinate assenti, o confidenza point-in-polygon sotto 0.6. Il wrapper cron **non** passa `require_omi_zone`, ma passa `scope: "global"`: la coppia comune/OMI resta comunque il collo di bottiglia principale.

Stato dati letto in sola lettura: `radar_signals` per Padova ha 31 righe, tutte attive, con `max(detected_at) = 2026-07-18`. Nessuna riga nuova da quella data.

## 3) Esiste un percorso di persistenza delle opportunità restituite?

Non da `agent-radar`. La persistenza delle opportunità avviene in job separati:
- `civiko-radar-veneto/padovaEarlyWarning.ts` → upsert su **`public.normalized_opportunities`** (`onConflict: fingerprint`, righe 259-597) più tracciamento su `ingestion_runs`; esposto da `/jobs/build-padova-early-warning`.
- Altre tabelle di segnale specializzate: `offmarket_opportunity_scores`, `urgent_opportunity_signals`, `pricing_error_signals`, `listing_velocity_signals`, `legal_property_signals` (tutte in `advancedOpportunity.ts`).
- Lettura pubblica: `core-offmarket-list-public`, `core-radar-signals-list`.

Tabella di persistenza canonica delle opportunità: `normalized_opportunities`; `radar_signals` è la tabella dei **segnali derivati**, non delle opportunità restituite dall'agente.

## 4) Il check `radar_signals_written` nel wrapper è un requisito reale?

No: è un **falso requisito**.

`supabase/functions/cron-radar-padova-nightly/index.ts` righe 309-347 conta le righe `radar_signals` con `detected_at >= triggered_at` e `municipality = Padova`; se il conteggio è `0` **oppure `null`** marca il run `failure` / HTTP 502 con `radar_write_verification_failed`. Ma il wrapper chiama esclusivamente `/agent-radar` (riga 65), che per costruzione non scrive su `radar_signals`. Inoltre:
- il match `municipality=eq.Padova` è case-sensitive, mentre le letture altrove usano `ilike`;
- `detected_at` è valorizzato dai job di derivazione, non dal path chiamato;
- un errore/timeout della query di conteggio produce `null` → fallimento anche con run riuscito.

Conclusione: il gate misura un contratto downstream inesistente per questo percorso e spiega i `failure` registrati in `cron_executions_log` per `central-core-radar-padova-soft` e `radar-padova-nightly-full`, indipendentemente dal successo effettivo dell'agente.

## Sintesi

1. `agent-radar` = read-only, restituisce opportunità/zone.
2. Candidati Padova da snapshots/motivated/anomalies/signals/OMI/aste/AOS; azzerabili da `comune !== padova`, mancanza di `omi_zone_code`, confidenza OMI < 0.6.
3. La persistenza opportunità esiste ma in `normalized_opportunities` via `/jobs/build-padova-early-warning`, non in `agent-radar`.
4. `radar_signals_written` nel wrapper è un falso requisito: da sostituire (in un intervento futuro, non incluso qui) con una verifica del contratto reale — es. esito HTTP + `total_opportunities`/`diagnostics` dell'agente, oppure spostando il gate sui job che scrivono davvero `radar_signals`.

Nessuna modifica proposta in questa richiesta: l'output è la sola diagnosi.
