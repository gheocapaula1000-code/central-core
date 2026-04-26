# Civiko One — Metodo Civiko One V1

Endpoint: `POST /functions/v1/civiko-property-from-photo`
Alias: `POST /functions/v1/civiko/metodo-civiko-one` (same handler, accepts the same body)

Orchestratore server-side per la pagina **Scansione** della Civiko One PWA.
Riceve foto + geolocalizzazione + dati rapidi, chiama internamente le Edge
Function Civiko esistenti, e restituisce **esattamente la struttura che la PWA
già renderizza**.

## Architettura

```
Civiko One PWA
   │
   ▼
POST /civiko/property-from-photo   ← unico endpoint per la PWA
   │
   ▼ (server-side fan-out, mai esposto alla PWA)
   civiko-property-source-profile
   civiko-property-hyperlocal-signals
   civiko-property-zona-in-movimento
   civiko-property-piano-esclusiva
```

La PWA non vede mai Sottra, OMI raw, ISPRA raw, scraping logic o API key.

## Request shape (PWA → backend)

```jsonc
{
  "photo": {
    "dataUrl": "data:image/jpeg;base64,...",
    "mimeType": "image/jpeg",
    "width": 1024,
    "height": 768,
    "sizeKb": 850
  },
  "geo": {
    "latitude": 45.4117,
    "longitude": 11.8853,
    "accuracy": 18,
    "manualAddress": "Via Tiziano Aspetti 12, Padova",
    "source": "device"          // device | manual | missing
  },
  "quickFacts": {
    "titoloInterno": "Trilocale Arcella",
    "zona": "Arcella",
    "tipologia": "Trilocale",
    "metratura": "85",
    "locali": "3",
    "prezzoRichiesto": "180000",
    "obiettivoProprietario": "Vendere entro 6 mesi",
    "obiezionePrincipale": "Provvigione",
    "urgenza": "Media",
    "targetAcquirente": "Famiglia giovane"
  }
}
```

Tutti i campi sono opzionali. La risposta è sempre ben formata.

## Response shape (backend → PWA)

```jsonc
{
  "configured": true,
  "message": "...",                 // opzionale (solo in fallback)
  "warnings": [],
  "updatedAt": "2026-04-26T10:00:00.000Z",

  "inputQuality": {
    "hasPhoto": true,
    "hasGeo": true,
    "hasManualAddress": false,
    "level": "buono"                // minimo | parziale | buono | completo
  },

  "immobileReale": {
    "title": "Trilocale Arcella",
    "address": "Via Tiziano Aspetti 12, Padova",
    "zone": "Arcella",
    "confidence": "alta",           // alta | media | bassa | non_definita
    "needsManualAddress": false
  },

  "fontiDaCollegare": [
    {
      "id": "omi",
      "title": "Riferimenti OMI",
      "status": "collegata",        // da_collegare | da_consultare | collegata | da_rivedere | non_disponibile
      "purpose": "Riferimenti di Mercato della zona OMI quando disponibili.",
      "sourceOwner": "Agenzia delle Entrate",
      "displayItems": [
        { "label": "Comune", "value": "Padova" },
        { "label": "Semestre", "value": "2025/1" },
        { "label": "Zone OMI Disponibili", "value": "12" }
      ]
    }
    // ... 7 aree garantite (omi, padova_municipality, neighborhood_context,
    //     territorial_data, cadastral_checks, schools_services, zone_signals)
  ],

  "zonaInMovimento": {
    "segnaliForti": [{ "id": "s_12", "label": "...", "detail": "..." }],
    "puntiAttenzione": [],
    "leveNarrative": [],
    "talkingPointsProprietario": []
  },

  "pianoEsclusiva": {
    "posizioneNegoziale": "...",
    "levaPrincipale": "...",
    "argomentoEsclusiva": "...",
    "rischioSenzaEsclusiva": "...",
    "frasiDaUsare": [],
    "prossimeAzioni": []
  },

  "presentazioneProprietario": {
    "sections": [
      { "id": "metodo_civiko_one",   "title": "Metodo Civiko One",   "status": "pronta",       "bullets": [] },
      { "id": "immobile_reale",      "title": "Immobile Reale",      "status": "pronta",       "bullets": [] },
      { "id": "fonti_da_collegare",  "title": "Fonti da Collegare",  "status": "da_validare",  "bullets": [] },
      { "id": "zona_in_movimento",   "title": "Zona in Movimento",   "status": "da_collegare", "bullets": [] },
      { "id": "piano_esclusiva",     "title": "Piano Esclusiva",     "status": "pronta",       "bullets": [] },
      { "id": "materiali_da_validare","title": "Materiali da Validare","status": "da_validare", "bullets": [] }
    ],
    "materialiDaValidare": []
  },

  "kitMarketing": { "available": false, "items": [] }
}
```

## Mapping interno

| Modulo PWA                 | Sorgente                                  | Campi mappati                                   |
| -------------------------- | ----------------------------------------- | ----------------------------------------------- |
| `fontiDaCollegare`         | `civiko-property-source-profile`          | `sourceAreas[].{id,title,status,...}`           |
| `zonaInMovimento.segnaliForti` | `civiko-property-zona-in-movimento`   | `strongSignals[]` + `futureNarrative[]`         |
| `zonaInMovimento.puntiAttenzione` | `civiko-property-zona-in-movimento` | `attentionSignals[]`                           |
| `zonaInMovimento.talkingPointsProprietario` | idem                          | `ownerTalkingPoints[]`                          |
| `pianoEsclusiva.*`         | `civiko-property-piano-esclusiva`         | `positioning.summary`, `mainLeverage[0]`, ecc.  |
| `presentazioneProprietario`| derivato dai 3 sopra + `quickFacts`       | sezioni renderizzabili con `bullets`            |

Quando un modulo interno fallisce, la sezione corrispondente cade su un default
commercialmente solido (status `da_collegare` / `da_preparare`) e viene aggiunto
un `warning`. **La PWA non riceve mai un crash o uno stack trace.**

## Regole sui dati

- **Fatti** vengono solo dalle Edge Function ufficiali (OMI/ISTAT/ISPRA via
  `source-profile`, signal table via `hyperlocal-signals`).
- **Raccomandazioni** del Piano Esclusiva sono generate ma sempre prudenti:
  nessuna promessa di risultato, nessun "valore reale", nessun "garantito".
- Se mancano coordinate **e** indirizzo manuale → `immobileReale.needsManualAddress = true`.
- Foto: **mai persistita di default**, mai rispedita, EXIF non esposto.

## Vocabolario

`sanitizeOutgoing` (definito in `_shared/civiko.ts`) rimuove ricorsivamente
da ogni stringa in uscita le parole vietate: `AI`, `IA`, `intelligenza`,
`intelligence`, `machine learning`, `smart`, `intelligent`, `intelligente`,
`stima`, `perizia`, `valutazione ufficiale`, `valutazioni ufficiali`,
`prezzo giusto`, `prezzo corretto`, `valore reale`, `garantito`, `garantita`.

Vocabolario consentito (e usato nei template): *Metodo Civiko One*, *Primo
Appuntamento*, *Proprietario*, *Immobile Reale*, *Incarico in Esclusiva*,
*Presentazione Proprietario*, *Dossier Venditore*, *Fonti da Collegare*,
*Zona in Movimento*, *Piano Esclusiva*, *Riferimenti OMI*, *Riferimenti di
Mercato*, *Segnali di Zona*, *Materiali da Validare*, *Valore Percepito*,
*Servizio Completo*.

## Comportamento con dati mancanti

| Scenario                                | Comportamento                                          |
| --------------------------------------- | ------------------------------------------------------ |
| Solo titolo                             | `inputQuality.level = "minimo"`, sezioni `da_preparare`|
| Solo foto                               | `level = "parziale"`, identità `non_definita`/`bassa`   |
| Solo geo device                         | `level = "parziale"`, `needsManualAddress = false`     |
| Foto + geo                              | `level = "buono"`                                      |
| Foto + geo + ≥5 fact                    | `level = "completo"`                                   |
| Niente geo né indirizzo                 | `needsManualAddress = true`                            |
| `source-profile` non risponde           | 7 aree default tutte `da_collegare`, warning aggiunto  |
| `hyperlocal` / `zona-in-movimento` ko   | `zonaInMovimento` vuoto, sezione `da_collegare`        |
| `piano-esclusiva` ko                    | Piano default commercialmente forte (testi statici)    |

## CORS / health

- `GET /health` → stato funzione + versione.
- `GET /manifest` → manifest standard Central Core.
- CORS: gestita da `enforceOriginPolicy` con whitelist Civiko One
  (`civikoone.com` e `localhost:5173` per dev).

## Note

- `kitMarketing.available` resta `false` finché non esiste un generatore reale.
- Stripe / billing non sono inclusi in questa V1 (richiesto esplicitamente).
- Nessuna persistenza foto, EXIF o coordinate oltre al ciclo richiesta.
