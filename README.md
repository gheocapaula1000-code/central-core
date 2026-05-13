# Central Core V3

Central Core è l'orchestratore proprietario multi-PWA. Gestisce provider, crediti, sicurezza, routing, funzioni operative e opportunità per Metodo Civiko One e per eventuali PWA presenti o future.

PWA principale attiva: **Metodo Civiko One**.  
PWA legacy: Wyloni, KeyDraft, Sottra.

## Documentazione

| Documento | Contenuto |
|-----------|-----------|
| [Contract Registry](docs/contract-registry.md) | Contratti API per tutte le PWA |
| [API Versioning](docs/api-versioning.md) | Versioning, stability tiers, deprecation policy |
| [Client Integration Guide](docs/client-integration-guide.md) | Come chiamare il Core, header, errori, retry |
| [Proxy Contract](docs/proxy-contract.md) | Standard per core-proxy nelle PWA client |
| [Operational Checklist](docs/operational-checklist.md) | Deploy, smoke test, upgrade coordinato |
| [Changelog](docs/changelog.md) | Storico modifiche API |
| [Release Pipeline](docs/release-pipeline.md) | CI/CD, smoke test, rollback |
| [OpenAPI Summary](docs/openapi-summary.yaml) | Specifica OpenAPI leggera |

## Edge Functions

| Funzione | Descrizione | Stabilità |
|----------|-------------|-----------|
| ai-core-run | Orchestratore principale: OpenAI → Anthropic fallback, Perplexity per web search | stable |
| sottra | 17 endpoint per scanner edifici (scan + forecast) | stable |
| viral-core | Motore privato per Viral Lab: generazione contenuti multicanale, policy check, media brief | stable |
| ecosystem-gateway | Orchestratore opzionale cross-app: enrichment, service-pack, report unificato | experimental |
| health | Health check | stable |

## Architettura
```
App (Wyloni/KeyDraft/Sottra)
  → core-proxy o chiamata diretta
    → Central Core V3 (questo repo)
      → ai-core-run (provider AI orchestrati)
      → sottra (scanner edifici)
      → ecosystem-gateway (layer additivo, opzionale, fail-safe)
         ↳ best-effort: sottra internals
         ↳ catalogo statico: servizi Wyloni
         ↳ NON chiama KeyDraft/Wyloni direttamente
      → viral-core (motore contenuti privato, via core-proxy)
         ↳ generazione multicanale (TikTok, Instagram, Facebook, LinkedIn)
         ↳ policy anti-ban/anti-spam deterministica
         ↳ media brief per generazione immagini
         ↳ NON pubblica sui social, NON fa scraping
```

## Variabili d'ambiente (Supabase Secrets)
```
# Per-app secrets (segmented — one per PWA, reduces blast radius)
AI_CORE_SECRET_WYLONI   # Secret per Wyloni
AI_CORE_SECRET_KEYDRAFT # Secret per KeyDraft
AI_CORE_SECRET_SOTTRA   # Secret per Sottra
AI_CORE_SECRET_REGIADS  # Secret per Regiads
AI_CORE_SECRET_PRATICA  # Secret per PRATICA

# Legacy (transitional fallback — will be deprecated)
AI_CORE_SECRET          # Secret condiviso legacy, usato se il per-app non è configurato

# Provider keys
OPENAI_API_KEY          # Provider primario
ANTHROPIC_API_KEY       # Provider fallback
PERPLEXITY_API_KEY      # Web search tasks
FIRECRAWL_API_KEY       # Web scraping (opzionale)

# Infrastructure
CORE_ALLOWED_ORIGINS    # Origins CORS (es: https://wyloni.app,https://keydraft.app)
GOOGLE_MAPS_API_KEY     # Geocoding per Sottra (opzionale)
DIAGNOSTIC_SECRET       # Accesso endpoint diagnostici/metriche
```

## Modello di accesso (v3.4.0)

L'accesso è regolato esclusivamente lato server con tre livelli:

### 1. Owner/Admin — `CORE_ADMIN_BOOTSTRAP_EMAILS`
- **Unico owner/admin**: `gheocapaula1000@gmail.com`
- Accesso completo a core admin, diagnostics, route protette, funzioni server-side
- Bypass completo di rate limit, quote, trial, piano, paywall
- Identità derivata da JWT Supabase verificato (`extractVerifiedEmail`)
- Nessun altro account può diventare admin tramite bootstrap

### 2. Utenti non paganti cross-app — `CORE_USER_BYPASS_EMAILS`
- Bypass di trial/piano/quote/paywall per tutti i servizi user-facing di tutte le PWA
- **Nessun accesso admin**, nessun pannello owner, nessuna capability amministrativa
- Esempio: `matteo.ippolito@gmail.com`

### 3. Utenti non paganti Wyloni-only — `CORE_WYLONI_BYPASS_EMAILS`
- Bypass di trial/piano/quote/paywall **solo** quando `x-source-app=wyloni`
- Nessun bypass globale cross-app, nessun accesso admin
- Il Core verifica `x-source-app` come segnale di routing (già autenticato via secret)
- Esempio: `massimilianogalli75@gmail.com`

### Sicurezza
- Nessun header, body, query string o localStorage può concedere privilegi admin
- Legacy `isAdminBypassEmail` e `checkAdminBypass` sono no-op permanenti
- Stripe non è una dipendenza del Core

## Gestione segreti e `.env`

- **Non versionare `.env`**: il file `.gitignore` esclude `.env` e `.env.*` dal repository.
- **`.env.example`**: contiene solo lo schema delle variabili (nomi senza valori reali).
- **Segreti runtime**: vanno configurati esclusivamente tramite Lovable Cloud (Secrets).
- **Mai stampare segreti nei log** o includerli in risposte API.
- **Per-app secrets**: ogni PWA deve avere il proprio `AI_CORE_SECRET_<APP>`. Il legacy `AI_CORE_SECRET` condiviso è supportato come fallback transitorio ma sarà deprecato.

## App Collegate

- **Wyloni** — Family office digitale (domini: wyloni_bandi, pratica_legal)
- **KeyDraft** — Scanner immobiliare (domini: keydraft_realestate)
- **Sottra** — Scanner edifici (domini: sottra)
