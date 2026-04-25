# Civiko One — Hyperlocal Signals

Central Core V3 backend for Civiko One. The PWA never sees datasets,
secrets or processing logic — only structured, source-aware payloads.

## Source Levels

| Level | Name              | Examples                                                     | Reliability | Visible in report |
|-------|-------------------|--------------------------------------------------------------|-------------|-------------------|
| 1     | Fonti Dure        | OMI, ISTAT, ISPRA, MIM, Comune di Padova, Tram Padova        | High        | Yes               |
| 2     | Segnali di Zona   | local press, urban planning blogs, association pages         | Medium      | Yes               |
| 3     | Local Buzz Signal | public forums, public groups, public reviews (aggregated)    | Low         | No (aggregate only)|
| 4     | Dati Interni Agenzia | exclusive mandates, owner objections, fees, time on market | High        | Tenant-scoped     |

## Tables

- `local_sources` — registry of sources with level, owner, reliability.
- `local_signals` — signals attached to a source, with category, geo, confidence, tone, commercial use.
- `property_signal_matches` — joins signals to a property opaque id.
- `agency_property_outcomes` — tenant-scoped agency outcomes.
- `owner_objection_patterns` — tenant-scoped objection catalog.

RLS:
- L1–L3 (`local_sources`, `local_signals`) are publicly readable when active.
- L4 (`agency_property_outcomes`, `owner_objection_patterns`) are tenant-scoped via `agency_id = auth.uid()`. Service role writes only.

## Endpoints

All endpoints accept `POST` with a JSON body and respond with JSON. CORS is restricted to allowlisted origins (Civiko One production + localhost dev). All outgoing strings are passed through the forbidden-vocabulary sanitizer.

### `POST /civiko/property-hyperlocal-signals`
Returns matched local signals for a property, with strict fact / commercial-use separation.

### `POST /civiko/property-zona-in-movimento`
Returns a source-aware "Zona in Movimento" profile (strong / attention / future signals + owner & buyer talking points).

### `POST /civiko/property-piano-esclusiva`
Returns a commercial plan to prepare the Primo Appuntamento and present the Incarico in Esclusiva.

### `POST /civiko/property-owner-report`
Aggregates the source profile, hyperlocal signals and Piano Esclusiva into the owner-facing Presentazione Proprietario sections.

### `POST /civiko/property-objection-plan`
Classifies an owner objection and returns a recommended response, phrase to use, supporting signals and follow-up action.

## Fact vs Recommendation Rule

Every signal is shaped as:

```jsonc
{
  "fact": {
    "title": "...",
    "summary": "...",
    "source": "...",
    "publishedAt": "...",
    "detectedAt": "...",
    "confidence": "high | medium | low"
  },
  "commercialUse": {
    "label": "Leva narrativa | Risposta preventiva | Punto da verificare | Follow-up",
    "suggestedUse": "...",
    "useInReport": true
  }
}
```

- `fact` is strict: source + dates + confidence. Never invented.
- `commercialUse` is bold but never adds new facts.
- L3 (Local Buzz Signal) never exposes evidence URLs and is excluded from the owner report (`useInReport: false`).

## Forbidden Vocabulary (hard sanitizer)

Outgoing copy is scrubbed of these terms before it leaves the backend:
`AI, IA, intelligenza, intelligence, machine learning, smart, intelligent, intelligente, stima, perizia, valutazione ufficiale, valutazioni ufficiali, prezzo giusto, prezzo corretto, valore reale, garantito, garantita`.

## Civiko Vocabulary (visible)

`Presentazione Proprietario, Dossier Venditore, Fonti da Collegare, Verifica di Supporto, Riferimenti OMI, Riferimenti di Mercato, Elementi di Zona, Segnali di Zona, Zona in Movimento, Piano Esclusiva, Local Buzz Signal, Metodo Civiko One, Servizio Completo, Kit Marketing Immobiliare, Piano di Valorizzazione, Materiali da Validare`.

## Level 3 — Local Buzz Signal Policy

- Aggregated only — never quote single users.
- Never name a zone "dangerous" or "bad".
- Always low/medium confidence unless strongly corroborated by L1.
- Never appears in the owner report.
- Used only as preparation for the agent (Risposta preventiva).

## Agency Proprietary Data Policy (L4)

- Strictly tenant-scoped via RLS.
- Never exposed across agencies.
- Backend writes go through service role.
- The PWA reads only its own agency's outcomes and objection patterns.

## Error Handling

- No stack traces, no source keys, no query details.
- Returns `status: partial`, affected source area as `da_rivedere` or `non_disponibile`, plus a `referenceId`.
