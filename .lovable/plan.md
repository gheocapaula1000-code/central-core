# Evidence Ledger Padova — Piano

## Stato attuale (verificato)

- 20 opportunità attive Padova in `early_warning_opportunities`: 16 `media`, 4 `bassa`, 0 `high`.
- Fonti ricorrenti: `casa.it`, `comune_padova_patrimonio`, `asteimmobili.it` — tutte city-level su Padova.
- Nessuna tabella `*evidence*` esistente. Nessun ledger.
- Anchor territoriali esistenti: `omi_zone_geometry` (con `omi_zone_by_point`), `microzone_padova_catalogo`, catalogo zone OMI. Manca tabella `padova_civici` (numeri civici).

## Cosa costruisco

### 1. Migration: tabella `opportunity_evidence`

Colonne: `opportunity_id` (FK logica a `early_warning_opportunities.id`), `source_name`, `source_url`, `geo_level` enum (`exact_address|street|microzone|district|city_level`), `signal_type`, `freshness_days`, `anticipatory_or_confirmation` (`anticipatory|confirmation|context`), `score_weight` (0–1), `privacy_safe`, `reason_for_weight`, `area_match` (jsonb: civico/via/microzona/zona_omi risolti), `collected_at`, `fingerprint` UNIQUE.

RLS: `service_role` full; `public_read` solo dove `privacy_safe=true`.

Indici su `opportunity_id`, `geo_level`, `signal_type`.

### 2. Migration: tabella `evidence_source_registry`

Catalogo di tutte le source_name ammesse con `default_geo_level`, `default_weight`, `default_anticipatory`, `privacy_class`, `priority_rank` (1=civici, 2=OMI, 3=geoportali/RNDT, 4=Comune Padova, 5=aste/PVP, 6=casa.it, 7=2ª fonte listing, 8=ISTAT/OSM contesto). Seed iniziale con le sorgenti già in uso + priorità FASE 4.

### 3. Edge function `padova-evidence-ledger`

`POST /padova-evidence-ledger?action=rebuild`

Per ogni opportunità Padova attiva:
1. Estrae fonti da `payload`, `source_names`, `source_urls`, `signal_types`.
2. Per ciascuna fonte interroga il registry → assegna `geo_level`, `score_weight`, `anticipatory_or_confirmation`, `privacy_safe`, `reason_for_weight`.
3. Tenta ancoraggio: se payload ha `lat/lng` → `omi_zone_by_point` → zona OMI; risolve microzona via `microzone_padova_catalogo`. Se solo comune/quartiere → `district` o `city_level`. Senza url reale → evidenza scartata (warning).
4. Inserisce/upserta righe in `opportunity_evidence`.

`POST /padova-evidence-ledger?action=rescore`

Applica le regole FASE 2:
- `high` solo se ≥2 evidenze microzone/street-level indipendenti **oppure** 1 microzone/street-level + 1 legale forte (PVP/Tribunale/Comune avviso) attribuite alla stessa area.
- City-level non promuove mai a `high`; resta `media` o si declassa a `bassa`.
- Asta city-level → `confirmation`, peso ridotto.
- Patrimonio comunale city-level → `context`, peso ridotto.
- Tutte evidenze devono avere `source_url` non vuoto, altrimenti escluse dal conteggio.

Aggiorna `early_warning_opportunities.confidence` e `payload.evidence_summary` (no inserimenti finti, no soglie abbassate).

`GET /padova-evidence-ledger?action=report` → output FASE 5.

### 4. Output report

Restituisce:
1. evidenze totali, 2. city-level, 3. microzone/street-level, 4. opportunità con ledger completo (≥1 evidence valida), 5. declassate (solo city-level), 6. high-confidence vere (post-regole), 7. top 5 microzone con fonti + geo_level, 8. gap per 1.490€/mese (es. mancanza numeri civici, mancanza 2ª fonte listing, copertura street-level <X%), 9. stato finale `DATA_PARTIAL` / `DATA_READY_FOR_1490_CONTROLLED_SALES` / `DATA_READY_FOR_PUBLIC_SALES`.

Soglie stato (proposte, non abbassabili):
- `DATA_READY_FOR_1490_CONTROLLED_SALES` ⟺ ≥3 opportunità high-confidence vere AND ≥40% evidenze microzone/street-level AND tutte le evidenze con `source_url` reale.
- `DATA_READY_FOR_PUBLIC_SALES` ⟺ ≥10 high-confidence vere AND ≥60% microzone/street + numeri civici Padova ingeriti.
- altrimenti `DATA_PARTIAL`.

## Cosa NON tocco

Stripe, checkout, portal, webhook, pricing, frontend, soglie esistenti del radar, dati personali, cron, mock. Nessuna nuova opportunità inventata: il job opera solo su record già presenti.

## Esecuzione

1. Migrations (`opportunity_evidence`, `evidence_source_registry` + seed).
2. Edge function `padova-evidence-ledger` (rebuild + rescore + report).
3. Curl rebuild → rescore → report e ti consegno il blocco FASE 5 reale.

Confermi e procedo, oppure vuoi modifiche al peso/soglie?
