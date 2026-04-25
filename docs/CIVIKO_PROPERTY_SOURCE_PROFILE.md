# Civiko One — Property Source Profile

Protected endpoint inside Central Core V3 that powers the Civiko One PWA
"Presentazione Proprietario" with a clean, source-aware view of a property.

## Architecture

```
Civiko One PWA  →  Central Core V3 (this endpoint)  →  Sottra / OMI / ISPRA / ISTAT / Comune di Padova / MIM / Firecrawl / Perplexity (where available)
```

- The PWA never sees datasets, formulas, scraping logic, source API keys
  or any internal processing.
- This endpoint returns only the structured `ProfileResponse` payload.
- All outgoing strings pass through a vocabulary sanitizer (see below).

## Endpoint

```
POST /functions/v1/civiko-property-source-profile
```

Aliases accepted on the path: `/civiko/property-source-profile`,
`/property-source-profile`.

Also exposes:

- `GET /health`
- `GET /manifest`

## Request body

```jsonc
{
  "agencyId": "optional string",
  "propertyDraft": {
    "title": "Trilocale luminoso",
    "address": "Via Tiziano Aspetti 10, Padova",
    "zone": "Arcella",
    "propertyType": "Appartamento",
    "sizeSqm": 95,
    "rooms": 3,
    "floor": "2",
    "hasElevator": true,
    "hasGarage": false,
    "hasTerrace": true,
    "hasGarden": false,
    "condition": "Buono stato",
    "askingPrice": 185000,
    "energyClass": "D",
    "internalNotes": "Proprietario aperto al Metodo Agenzia.",
    "ownerGoal": "Vendere entro l'estate",
    "ownerTiming": "3-6 mesi",
    "ownerPriority": "Tempo",
    "strengths": "Doppia esposizione, terrazzo abitabile",
    "knownIssues": "Bagno da rinnovare",
    "ownerQuestions": "Quanto possiamo realmente ottenere?"
  },
  "requestedSourceAreas": [
    "omi",
    "padova_municipality",
    "neighborhood_context",
    "territorial_data",
    "cadastral_checks",
    "schools_services",
    "zone_signals"
  ]
}
```

If `requestedSourceAreas` is omitted, all seven areas are returned.

## Response body

```jsonc
{
  "profileId": "string",
  "status": "ok | partial | unavailable",
  "propertySummary": {
    "title": "string",
    "address": "string",
    "zone": "string",
    "propertyType": "string",
    "displayLabel": "Immobile Reale"
  },
  "sourceAreas": [
    {
      "id": "omi",
      "title": "Riferimenti OMI",
      "label": "Fonte da Collegare | Verifica di Supporto | Collegata | Da Rivedere | Non Disponibile",
      "status": "da_collegare | da_consultare | collegata | da_rivedere | non_disponibile",
      "sourceOwner": "Agenzia delle Entrate",
      "purpose": "Riferimenti di Mercato e zona OMI quando disponibili.",
      "summary": "string",
      "displayItems": [{ "label": "string", "value": "string" }],
      "lastCheckedAt": "ISO date or null",
      "notes": ["string"]
    }
  ],
  "presentationHints": [
    {
      "title": "string",
      "body": "string",
      "section": "Presentazione Proprietario | Dossier Venditore | Fonti da Collegare | Piano di Valorizzazione"
    }
  ],
  "warnings": ["string"],
  "updatedAt": "ISO date"
}
```

## Source area statuses

| Status            | Label visibile          | Meaning                                                                 |
| ----------------- | ----------------------- | ----------------------------------------------------------------------- |
| `da_collegare`    | Fonte da Collegare      | Source recognized but not yet wired to this profile.                    |
| `da_consultare`   | Verifica di Supporto    | Source exists offline / requires manual consultation by the agency.     |
| `collegata`       | Collegata               | Real data returned from a connected internal source.                    |
| `da_rivedere`     | Da Rivedere             | Source partially available or matching uncertain — needs human review.  |
| `non_disponibile` | Non Disponibile         | Source not applicable for this property (e.g. outside Padova in V1).    |

## Source areas — what is and is not returned

1. **Riferimenti OMI** (`omi`) — when OMI tables are populated for Padova,
   returns zone count, semestre, tipologie, status. **Never** returns euro
   values, estimates, valuations, "prezzo", "valore" or similar.
2. **Comune di Padova** (`padova_municipality`) — currently `da_consultare`:
   the cartography / Piano degli Interventi must be checked manually.
3. **Contesto di Quartiere** (`neighborhood_context`) — returns ISTAT
   demographic snapshot for Comune di Padova when present (popolazione,
   età media, quote under 35 / over 65, anno).
4. **Dati Territoriali** (`territorial_data`) — returns ISPRA hydrogeological
   indicators and seismic zone for Comune di Padova when present. Phrased as
   "Verifica di Supporto Territoriale" — never as alarmist claims.
5. **Verifiche Catastali** (`cadastral_checks`) — always `da_consultare`:
   conformity is never auto-asserted.
6. **Scuole e Servizi** (`schools_services`) — returns the comune-level count
   of MIM-registered schools when populated. Per-property proximity requires
   coordinates and is therefore marked `da_rivedere`.
7. **Segnali di Zona** (`zone_signals`) — future area; always `da_collegare`
   in V1. No external scraping is performed even if Firecrawl / Perplexity
   keys exist.

## What is never returned

- No fabricated values, prices, or estimates.
- No internal table names, SQL, Supabase identifiers, or row IDs.
- No API keys, secrets, or env var values.
- No raw dataset rows beyond the safe `displayItems` projection.
- No private user names, comments, or quotes from external sources.
- No forbidden vocabulary (see below).

## Vocabulary policy (enforced server-side)

Every outgoing string in the JSON payload is recursively sanitized.
The following words / phrases are stripped before the response is sent:

```
AI, IA, Intelligenza, Intelligence, Machine Learning,
smart, intelligent, intelligente,
stima, perizia,
valutazione ufficiale, valutazioni ufficiali,
prezzo giusto, prezzo corretto, valore reale,
garantito, garantita
```

Allowed Civiko One vocabulary (used by this endpoint):
Agenzie Immobiliari · Padova · Immobile Reale · Incarico in Esclusiva ·
Esclusiva di Vendita · Metodo Agenzia · Presentazione Proprietario ·
Dossier Venditore · Fonti da Collegare · Fonte da Collegare ·
Verifica di Supporto · Verifiche di Supporto · Riferimenti OMI ·
Dati Inseriti dall'Agenzia · Piano di Valorizzazione ·
Kit Marketing Immobiliare · Valore Percepito · Quid in Più ·
Servizio Completo · Materiali da Validare · Elementi di Zona ·
Riferimenti di Mercato · Segnali di Zona.

## Security principle

- Central Core V3 stays the protected processing engine.
- Civiko One PWA only renders Central Core V3 responses.
- Origin allowlist + CORS gating apply (see `CORE_ALLOWED_ORIGINS`).
- A future per-app secret / verified JWT layer is reserved for V1.1;
  the auth scaffold is in place internally but never surfaced to the
  client payload.
- Validation rejects malformed bodies with `400 INVALID_BODY` and
  unknown source areas. No SQL is ever constructed from user input.

## Test payload — Trilocale in Arcella · Padova

```bash
curl -X POST \
  https://<project>.functions.supabase.co/civiko-property-source-profile \
  -H "Content-Type: application/json" \
  -H "Origin: https://civikoone.com" \
  -d '{
    "agencyId": "demo-agency",
    "propertyDraft": {
      "title": "Trilocale luminoso in Arcella",
      "address": "Via Tiziano Aspetti 10, Padova",
      "zone": "Arcella",
      "propertyType": "Appartamento",
      "sizeSqm": 95,
      "rooms": 3,
      "floor": "2",
      "hasElevator": true,
      "hasTerrace": true,
      "condition": "Buono stato",
      "askingPrice": 185000,
      "energyClass": "D",
      "ownerGoal": "Vendere entro l estate",
      "ownerTiming": "3-6 mesi",
      "ownerPriority": "Tempo",
      "strengths": "Doppia esposizione, terrazzo abitabile",
      "knownIssues": "Bagno da rinnovare"
    }
  }'
```

The response will contain real source-area statuses based on what is
actually populated in Central Core V3 today — never fabricated values.
