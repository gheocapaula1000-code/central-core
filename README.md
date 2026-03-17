# Central Core V3

Backend condiviso (Supabase Edge Functions) per Wyloni, KeyDraft e Sottra. Gestisce orchestrazione provider, rate limiting e routing.

## Edge Functions

| Funzione | Descrizione |
|----------|-------------|
| ai-core-run | Orchestratore principale: OpenAI → Anthropic fallback, Perplexity per web search |
| sottra | 8 endpoint per scanner edifici (scan + forecast) |
| ecosystem-gateway | Orchestratore opzionale cross-app: enrichment, service-pack, report unificato |
| health | Health check |

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
