# Civiko One — Metodo Sottra Automatico (Foto + Geolocalizzazione)

Central Core V3 espone un orchestratore protetto per l'esperienza vincente di Civiko One:

> Da una foto e dalla geolocalizzazione → Identificazione → Riferimenti → Segnali → Piano Esclusiva → Presentazione Proprietario.

La PWA Civiko One non vede dataset, motori Sottra, formule, fonti grezze, segreti o logiche di scraping. Vede solo l'output finale e strutturato.

## Endpoint

| Metodo | Path | Scopo |
|---|---|---|
| POST | `/civiko/property-from-photo` | Orchestratore principale |
| POST | `/civiko/metodo-civiko-one`   | Alias semantico (stessa funzione) |

Entrambi sono serviti dalla edge function `civiko-property-from-photo`.

### Body in ingresso (sintesi)

```json
{
  "agencyId": "uuid?",
  "capture":  { "photoBase64": "...", "mimeType": "image/jpeg", "fileSizeBytes": 350000, "capturedAt": "2026-04-26T10:00:00Z" },
  "geo":      { "lat": 45.4064, "lng": 11.8768, "accuracyMeters": 18, "source": "gps" },
  "propertyDraft": { "title": "...", "address": "...", "zone": "...", "askingPrice": 280000, "ownerGoal": "..." },
  "requestedOutputs": ["source_profile", "hyperlocal_signals", "zona_in_movimento", "piano_esclusiva", "owner_report"]
}
```

### Body in uscita (forma)

```json
{
  "runId": "string",
  "status": "ok | partial | unavailable",
  "inputQuality": { "photoAccepted": true, "geoAccepted": true, "needsManualAddress": false, "needsBetterPhoto": false, "needsLocation": false, "notes": [] },
  "propertyIdentity": { "title": "...", "address": "...", "municipality": "Padova", "lat": 45.4, "lng": 11.87, "confidence": "high", "source": "mixed" },
  "sourceProfile":      { ... },
  "hyperlocalSignals":  { ... },
  "zonaInMovimento":    { ... },
  "pianoEsclusiva":     { ... },
  "ownerReport":        { ... },
  "materialsToValidate":[ { "label": "...", "status": "da_verificare" } ],
  "moduleStatuses":     { "sourceProfile": "ok", "hyperlocalSignals": "ok", "zonaInMovimento": "ok", "pianoEsclusiva": "ok", "ownerReport": "ok" },
  "billingGate":        { "allowed": true, "billingReady": false, "plan": null, "usage": {}, "limits": {}, "upgradeRequired": false },
  "warnings": [],
  "updatedAt": "ISO date"
}
```

## Orchestrazione

`civiko-property-from-photo` chiama in sequenza/parallelo i Civiko siblings via HTTP interno:
1. `civiko-property-source-profile`
2. `civiko-property-hyperlocal-signals`
3. `civiko-property-zona-in-movimento`
4. `civiko-property-piano-esclusiva` (richiede 1+2)
5. `civiko-property-owner-report` (richiede 1+2+4)

Gli endpoint Sottra/OMI/ISTAT non sono mai chiamati direttamente dal frontend e non sono mai esposti dall'orchestratore: il riuso del *Metodo Sottra* avviene solo server-side dentro le funzioni Civiko.

### Mappatura motori → output Civiko

| Motore Sottra | Output Civiko user-facing |
|---|---|
| scan/identify | Identificazione Immobile |
| scan/pricing + OMI | Riferimenti OMI / Riferimenti di Mercato |
| forecast/infrastrutture | Zona in Movimento / Elementi di Zona |
| forecast/rischio-zona | Verifiche di Supporto Territoriale |
| forecast/trend-demografico | Contesto di Quartiere |
| forecast/sviluppo-area | Segnali di Trasformazione |
| forecast/convergenza-territoriale | Quadro di sintesi per Piano Esclusiva |

## Foto

- La foto è validata su MIME (`image/jpeg|webp|png`) e dimensione (≤ 8 MB).
- Mai persistita di default. Mai rimandata indietro nei payload.
- Se assente o scarsa: `inputQuality.needsBetterPhoto = true`.
- Se la geolocalizzazione manca: `inputQuality.needsLocation = true`.
- Se foto e GPS sono discordanti rispetto a Padova: `status = "partial"` + warning.

## Sanitizzazione vocabolario

Ogni stringa in uscita passa per `sanitizeOutgoing` (vedi `_shared/civiko.ts`). Sono **vietati** in output user-facing: AI, IA, Intelligenza, Intelligence, Machine Learning, smart, intelligent/intelligente, stima, perizia, valutazione/valutazioni ufficiale/i, prezzo giusto/corretto, valore reale, garantito/a.

## Stripe / Billing

Predisposizione completa server-side. Endpoint dedicati su `civiko-billing`:

| Metodo | Path | Scopo |
|---|---|---|
| POST | `/civiko/billing/create-checkout`     | Avvia Checkout Stripe per il piano scelto |
| POST | `/civiko/billing/customer-portal`     | Apre il Customer Portal Stripe |
| POST | `/civiko/billing/check-subscription`  | Stato abbonamento + uso corrente |
| POST | `/civiko/billing/record-usage`        | Registra utilizzo manuale |
| POST | `/civiko/billing/stripe-webhook`      | Webhook Stripe (firma verificata HMAC-SHA256) |

### Variabili d'ambiente attese

| Variabile | Uso |
|---|---|
| `STRIPE_SECRET_KEY` | Chiave Stripe (server-only) |
| `STRIPE_WEBHOOK_SECRET` | Firma webhook |
| `CIVIKO_STRIPE_PRICE_STUDIO_MONTHLY` | Price ID Studio mensile |
| `CIVIKO_STRIPE_PRICE_PRO_MONTHLY`    | Price ID Pro mensile |
| `CIVIKO_STRIPE_PRICE_ELITE_MONTHLY`  | Price ID Elite mensile |
| `CIVIKO_STRIPE_PRICE_STUDIO_ANNUAL`  | Price ID Studio annuale |
| `CIVIKO_STRIPE_PRICE_PRO_ANNUAL`     | Price ID Pro annuale |
| `CIVIKO_STRIPE_PRICE_ELITE_ANNUAL`   | Price ID Elite annuale |

Se `STRIPE_SECRET_KEY` non è configurata:
- Tutti gli endpoint billing rispondono `200 { billingReady: false, reason: "billing_not_configured" }`.
- L'orchestratore continua a funzionare e include `billingGate.billingReady: false`.
- **Nessun pagamento finto, nessun bypass nascosto in produzione.**

L'IBAN/CC dell'agenzia non è mai nel codice — si configura nel dashboard Stripe.

### Tabelle billing

- `billing_customers` — link agency → Stripe customer
- `billing_subscriptions` — stato abbonamento corrente
- `billing_usage` — contatori mensili (scan / owner_report / piano_esclusiva / zona_in_movimento / hyperlocal_signals)
- `billing_entitlements` — limiti e flag per piano (`civiko_studio` / `civiko_pro` / `civiko_elite`)

Tutte tenant-scoped via RLS (`agency_id = auth.uid()` per `authenticated`, `service_role` ha pieno accesso).

## Sicurezza

- CORS controllato da `CORE_ALLOWED_ORIGINS` (no wildcard in produzione).
- Webhook Stripe: firma HMAC-SHA256 verificata prima di qualunque scrittura.
- Mai loggare il body raw del webhook, mai la secret.
- Errori user-facing privi di stack trace, SQL details, chiavi, output grezzo dei provider.
- Foto mai loggata.

## Test payload di esempio

Quattro zone Padova + casi degenerati sono coperti dal test contract `src/test/civiko-metodo-sottra-contract.test.ts`:

1. Arcella — `{ lat: 45.4226, lng: 11.8745 }`
2. Centro Storico — `{ lat: 45.4064, lng: 11.8768 }`
3. Stazione / Voltabarozzo — `{ lat: 45.4170, lng: 11.8842 }`
4. Chiesanuova / Rubano (zona ovest) — `{ lat: 45.4070, lng: 11.8350 }`
5. Missing GPS — `geo: {}` → `needsLocation: true`
6. Poor photo — formato non supportato → `needsBetterPhoto: true`
7. Missing Stripe config → `billingGate.billingReady: false, allowed: true`
8. Limit reached (mock) → `billingGate.allowed: false, upgradeRequired: true`
