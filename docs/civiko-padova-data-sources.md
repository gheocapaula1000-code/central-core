# Civiko — Fonti dati Padova

Registry unificato in `public.civiko_source_registry`. Tutte le tabelle dati sono admin-only.

## Codici fonte

| Codice | Nome | Accesso | Compliance | Stato | Tabella |
|--------|------|---------|------------|-------|---------|
| F3  | ISTAT APR4 — Iscritti residenza | public_file | public | planned | `istat_apr4_mobility` |
| F4  | Comune Padova — Popolazione anziana | manual_import | public | planned | `padova_elderly_population` |
| F12 | Borsino Immobiliare / FIAIP — Benchmark prezzi | manual_import | public | planned | `market_benchmark_padova` |
| F15 | Conservatoria / Ipotecarie via OpenAPI.it | paid_gateway | sensitive_restricted | disabled | `restricted_report_audit` |
| F17 | Veneto APE — Registro ufficiale | public_api | public | partial | — (stima AI etichettata) |
| F18 | Comune Padova — SUE pratiche edilizie | public_api | public | live | `sue_padova_permits` + `local_signals` (OSM) |
| F20 | ISTAT APR4 — Cancellati residenza | public_file | public | planned | `istat_apr4_mobility` |
| F22 | ISTAT — Separazioni/divorzi | public_file | sensitive_aggregate | planned | `istat_separations_padova` |

## Edge functions

### `civiko-source-registry` (admin-only JWT)
- `GET /civiko-source-registry/sources`
- `POST /civiko-source-registry/import/elderly-population` — F4
- `POST /civiko-source-registry/import/apr4-mobility` — F3+F20
- `POST /civiko-source-registry/import/market-benchmark` — F12
- `POST /civiko-source-registry/import/sue-permits` — F18 (richiede `compliance_verified=true` per riga)
- `POST /civiko-source-registry/import/separations` — F22

Body JSON: `{ csv: "<raw csv>", source_url?: string }` oppure `{ rows: [...], source_url?: string }`.

### `civiko-restricted-report` (utente autenticato, gated)
- `POST /civiko-restricted-report` per F15.
- Richiede:
  - JWT utente
  - `body.target_ref` (identificatore opaco, mai PII raw)
  - `body.acknowledged_cost === true`
  - env `F15_CONSERVATORIA_ENABLED=true` + `OPENAPI_IT_TOKEN`
- Scrive sempre una riga `restricted_report_audit` prima di chiamare il provider.
- **Nessuna mass scan**: una chiamata = un target.
- Payload sensibile mai persistito in tabelle.

## Schemi CSV importer

**F4** — `padova_elderly_population`
```
year,area_name,area_code,over_65_count,over_75_count,total_population
2024,Arcella,01,4200,2100,18500
```

**F3/F20** — `istat_apr4_mobility`
```
year,comune,comune_istat,iscritti,cancellati,saldo_migratorio,transfer_rate
2024,Padova,028060,7800,7950,-150,0.0356
```

**F12** — `market_benchmark_padova`
```
period,area_name,min_price_eur_mq,max_price_eur_mq,avg_price_eur_mq,rent_eur_mq_month,source_name,source_url
2025-Q1,Arcella,1600,2200,1900,9.5,borsino_immobiliare,https://...
```

**F18** — `sue_padova_permits`
```
area_name,address_public,practice_type,practice_date,status,source_url,compliance_verified
Arcella,Via Tiziano Aspetti,permesso_costruire,2024-09-12,rilasciato,https://opendata...,true
```
Righe con `compliance_verified` diverso da `true` sono rifiutate.

**F22** — `istat_separations_padova`
```
year,comune,comune_istat,separations_count,divorces_count,marriages_count,separation_rate,divorce_rate
2023,Padova,028060,420,310,1200,0.0021,0.0015
```

## Compliance guard (`_shared/compliance.ts`)
- `assertAggregateOnly`: ogni importer aggregato rifiuta righe con campi person-level (nome, CF, owner, erede, coniuge, defunto, ecc.).
- `redactSensitiveForPwa`: filtra payload destinati al frontend rimuovendo campi person-level e blocchi `compliance_level=sensitive_restricted`.

## Scoring (`_shared/civikoScoring.ts`)
- Pesi: F4 0.20, F3 0.20, F12 0.15, F18 0.15, F22 0.05.
- Ogni contributo include `{source_code, value, confidence, last_updated, explanation}`.
- Niente score senza attribution. Fonti mancanti elencate in `missing_sources`.

## F17 APE — labeling
Lo scoring/output APE corrente è una stima euristica. Il payload PWA deve sempre includere:
```
{ value: "C", source: "ai_estimate", official_source_status: "planned",
  disclaimer: "Classe energetica stimata, non sostituisce APE ufficiale." }
```
Registry: `implementation_status='partial'`.

## F15 workflow
1. Utente PWA conferma costo → frontend chiama `civiko-restricted-report` con `acknowledged_cost: true`.
2. Se flag/env mancanti → `403 FEATURE_NOT_ENABLED` (audit row con status=`denied`).
3. Se abilitato → audit row `requested`, chiamata provider, update `completed`/`failed`.
4. Dati persona ritornano solo nel response, mai in DB. Mass-scan esplicitamente vietato.
