# Listing Bridge — Central Core V3

## Scopo

Modulo bridge isolato che trasporta dati di listing da **KeyDraft** a **Sottra** attraverso Central Core V3, senza creare dipendenze dirette tra le due PWA.

```
KeyDraft → [export] → listing-bridge/ingest → [validate → normalize → transform] → Sottra/scan/import
```

## Principi

- **Isolamento**: il bridge è un modulo separato, non mischia logica di KeyDraft o Sottra nel core
- **Trasporto, non interpretazione**: valida, normalizza e inoltra — non decide contenuto editoriale
- **Idempotenza**: trace_id unico, nessuna doppia importazione
- **Tracciabilità**: ogni job ha stati chiari e audit trail via DB

## Endpoint

| Metodo | Path | Auth | Descrizione |
|--------|------|------|-------------|
| GET | `/health` | No | Health check |
| GET | `/manifest` | No | Self-description |
| POST | `/ingest` | AI_CORE_SECRET | Ingresso payload da KeyDraft |
| GET | `/status/:trace_id` | AI_CORE_SECRET | Stato di un job |
| POST | `/retry/:trace_id` | AI_CORE_SECRET | Ritenta un job fallito |

## Schema Canonico (v1.0)

```json
{
  "schema_version": "1.0",
  "source": {
    "app": "keydraft",
    "environment": "production",
    "exported_at": "2026-03-21T10:00:00Z",
    "bridge_trace_id": "uuid-or-trace-id"
  },
  "listing": {
    "listing_id": "string",
    "run_id": "string",
    "status": "ready_for_export"
  },
  "property": { "property_type": "string|null", "rooms_estimated": "number|null", "bathrooms_estimated": "number|null", "photo_count": "number|null" },
  "photo_derived": { "materials_detected": [], "features_detected": [], "confidence_flags": [] },
  "agent_supplied": { "structured_features": { "garage": true, "cantina": false, "..." : "..." }, "freeform_notes": "string|null" },
  "generated_text": { "primary_listing_text": "string (required)", "listing_text_long": "string|null", "listing_text_short": "string|null", "listing_social_variants": ["string"] },
  "sharing": { "whatsapp_ready_summary": "string|null" },
  "origin_map": { "primary_listing_text": { "from": ["photo_derived", "agent_supplied"] } },
  "bridge_status": { "export_status": "not_sent|queued|sent|imported|failed" }
}
```

## Stati del Job

```
received → validated → transformed → delivered → imported
                                  ↘ failed (retryable fino a 3 tentativi)
```

| Stato | Significato |
|-------|------------|
| `received` | Payload ricevuto e salvato |
| `validated` | Schema validato |
| `transformed` | Payload trasformato per Sottra |
| `delivered` | Consegnato a Sottra con successo |
| `imported` | Confermato importato da Sottra (futuro) |
| `failed` | Errore — ritentabile |

## Sicurezza

- Autenticazione via `AI_CORE_SECRET` (stessi header del core)
- Origin policy uniforme (`enforceOriginPolicy`)
- Identity headers su tutte le risposte
- Nessun segreto nei log o nei payload di errore
- Accesso DB via `service_role` (RLS policy dedicata)

## Tabella DB

`listing_bridge_jobs` — traccia ogni job con:
- `trace_id` (unique) — idempotenza
- `listing_id` + `run_id` (unique) — deduplicazione
- `status`, `payload`, `sottra_payload`, `sottra_response`
- `retry_count`, `error_message`, timestamps

## Punti di estensione futuri

1. **Webhook callback**: Sottra conferma `imported` via callback
2. **Schema v2.0**: aggiunta campi senza rompere v1.0
3. **Batch ingest**: endpoint per importazioni multiple
4. **Metriche bridge**: contatori delivery success/failure
5. **Altre destinazioni**: il bridge può inoltrare a servizi diversi da Sottra
