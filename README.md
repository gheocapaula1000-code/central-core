# Central Core V3

Backend condiviso (Supabase Edge Functions) per Wyloni, KeyDraft e Sottra. Gestisce orchestrazione provider, rate limiting e routing.

## Edge Functions

| Funzione | Descrizione |
|----------|-------------|
| ai-core-run | Orchestratore principale: OpenAI → Anthropic fallback, Perplexity per web search |
| sottra | 8 endpoint per scanner edifici (scan + forecast) |
| health | Health check |

## Architettura
```
App (Wyloni/KeyDraft/Sottra)
  → core-proxy o chiamata diretta
    → Central Core V3 (questo repo)
      → ai-core-run (provider AI orchestrati)
      → sottra (scanner edifici)
```

## Variabili d'ambiente (Supabase Secrets)
```
AI_CORE_SECRET          # Secret condiviso per autenticazione
OPENAI_API_KEY          # Provider primario
ANTHROPIC_API_KEY       # Provider fallback
PERPLEXITY_API_KEY      # Web search tasks
CORE_ALLOWED_ORIGINS    # Origins CORS (es: https://wyloni.app,https://keydraft.app,https://sottra.app)
GOOGLE_MAPS_API_KEY     # Geocoding per Sottra (opzionale, fallback su Nominatim)
```

## App Collegate

- **Wyloni** — Family office digitale (domini: wyloni_bandi, pratica_legal)
- **KeyDraft** — Scanner immobiliare (domini: keydraft_realestate)
- **Sottra** — Scanner edifici (domini: sottra)
