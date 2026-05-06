# Central Core — Contratto Endpoint Agency CRUD

Endpoint chiamabili dal proxy `civiko-agency-area` di Civiko One.

## Headers richiesti

| Header           | Obbligatorio | Note                                          |
|------------------|--------------|-----------------------------------------------|
| `x-job-secret`   | Sì           | `CENTRAL_CORE_JOB_SECRET` (server-side proxy) |
| `x-user-id`      | Sì           | UUID utente autenticato lato Civiko One       |
| `x-user-email`   | No           | Usato solo per `billing_email` su `/personal` |
| `Content-Type`   | Sì           | `application/json`                            |

`user_id` nel body **non viene fidato**. Solo `x-user-id` conta.

## Error codes

| Code                  | HTTP | Descrizione                          |
|-----------------------|------|--------------------------------------|
| `MISSING_USER_ID`     | 400  | Header `x-user-id` mancante          |
| `VALIDATION_ERROR`    | 400  | Payload incompleto o invalido        |
| `UNAUTHORIZED_AGENCY` | 403  | Utente non member attivo della agency|
| `FORBIDDEN_ROLE`      | 403  | Richiesto ruolo owner/admin          |
| `AREA_NOT_FOUND`      | 404  | Area non esiste o non appartiene     |
| `DB_ERROR`            | 500  | Errore lato database                 |

## Endpoints

Tutti `POST` su `/civiko-radar-veneto/...`.

### `/agency/personal`
Body: `{ "agency_name"?: string }` → `{ ok, agency, membership, created }`
Crea agency + owner membership se mancante; idempotente.

### `/agency/operating-areas/list`
Body: `{ "agency_id": uuid, "include_inactive"?: bool }` → `{ ok, areas: [] }`
Richiede membership attiva.

### `/agency/operating-areas/create`
Body: `{ agency_id, label?, province[], comuni[], microzones?[], quartieri?[], focus?[], is_default? }`
Owner/admin. Almeno `province` o `comuni` non vuoti. Se `is_default=true` resetta le altre.

### `/agency/operating-areas/update`
Body: `{ id, agency_id, patch: { label?, province?, comuni?, microzones?, quartieri?, focus?, is_default? } }`
Owner/admin. Verifica appartenenza area.

### `/agency/operating-areas/deactivate`
Body: `{ id, agency_id }` → `is_active=false`, `is_default=false`. No delete fisica.

### `/agency/signal-preferences/get`
Body: `{ agency_id, operating_area_id }` → `{ ok, preferences, is_default }`
Se assenti, ritorna default sicuri (`exclude_auctions=true`, no sensitive_turnover, ecc.).

### `/agency/signal-preferences/upsert`
Body: `{ agency_id, operating_area_id, preferences: {...} }` → `{ ok, preferences, created }`
Owner/admin. Aggiorna o crea record per `(agency_id, operating_area_id)`.

## Default sicuri

```json
{
  "min_confidence": 0.55,
  "exclude_auctions": true,
  "include_public_alienations": false,
  "include_sensitive_turnover": false,
  "include_sensitive_turnover_aggregated": true,
  "include_urban_planning": true,
  "include_mobility": true,
  "include_services": true,
  "include_green_risk_sentiment": true,
  "include_tourism": false
}
```
