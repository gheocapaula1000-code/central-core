# Central Core V3

Backend condiviso (Supabase Edge Functions) per Wyloni, KeyDraft e Sottra. Gestisce orchestrazione provider, rate limiting e routing.

## Documentazione

| Documento | Contenuto |
|-----------|-----------|
| [Contract Registry](docs/contract-registry.md) | Contratti API per tutte le PWA |
| [API Versioning](docs/api-versioning.md) | Versioning, stability tiers, deprecation policy |
| [Client Integration Guide](docs/client-integration-guide.md) | Come chiamare il Core, header, errori, retry |
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
AI_CORE_SECRET          # Secret condiviso per autenticazione
OPENAI_API_KEY          # Provider primario
ANTHROPIC_API_KEY       # Provider fallback
PERPLEXITY_API_KEY      # Web search tasks
CORE_ALLOWED_ORIGINS    # Origins CORS (es: https://wyloni.app,https://keydraft.app,https://sottra.app)
GOOGLE_MAPS_API_KEY     # Geocoding per Sottra (opzionale, fallback su Nominatim)
DIAGNOSTIC_SECRET       # Accesso endpoint diagnostici/metriche
FIRECRAWL_API_KEY       # Web scraping (opzionale)
```

## Gestione segreti e `.env`

- **Non versionare `.env`**: il file `.gitignore` esclude `.env` e `.env.*` dal repository.
- **`.env.example`**: contiene solo lo schema delle variabili (nomi senza valori reali). Serve come riferimento.
- **Segreti runtime**: vanno configurati esclusivamente tramite Lovable Cloud (Secrets) o Supabase Dashboard → Settings → Edge Functions → Secrets.
- **Mai stampare segreti nei log** o includerli in risposte API.
- **Sincronizzazione**: `AI_CORE_SECRET` deve essere identico in tutti i progetti dell'ecosistema (Central Core, Wyloni, KeyDraft, Sottra).

## App Collegate

- **Wyloni** — Family office digitale (domini: wyloni_bandi, pratica_legal)
- **KeyDraft** — Scanner immobiliare (domini: keydraft_realestate)
- **Sottra** — Scanner edifici (domini: sottra)
