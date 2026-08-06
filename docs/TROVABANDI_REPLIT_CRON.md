# TrovaBandi — pipeline Replit (Europe/Rome)

La Reserved VM Replit è l'unico scheduler. Lovable serve la PWA; Central Core conserva ed espone il catalogo.

## Azioni consentite

Replit può chiamare soltanto:

- `collect`: seleziona una fonte dovuta, scopre candidati, estrae al massimo `max_pages` documenti e persiste prove e risultato.
- `maintenance`: marca come scaduti i bandi con termine passato e chiude fail-closed i run `RUNNING` bloccati da oltre 20 minuti.
- `release_gate`: certifica catalogo attivo, copertura reale di tutte le fonti abilitate nelle ultime 26 ore e assenza di run bloccati.
- `status`: stato sintetico senza segreti.

Per il collaudo, `collect` accetta `"dry_run": true`: esegue soltanto la selezione fair e restituisce la fonte che verrebbe raccolta, senza lease, provider o scritture database.

Endpoint: `POST {CENTRAL_CORE_API_URL}/functions/v1/trovabandi-engine`

Header server-side:

- `x-internal-secret: {CENTRAL_CORE_API_KEY}`
- `Authorization: Bearer {CENTRAL_CORE_API_KEY}`
- `Content-Type: application/json`

Il secret non deve apparire nei log o nei risultati salvati.

## Orari di produzione

| Job                         | Cron Europe/Rome | Operazione                                                   |
| --------------------------- | ---------------- | ------------------------------------------------------------ |
| `trovabandi-night-deep`     | `10 1 * * *`     | 12 chiamate `collect`, `max_pages: 4`, concorrenza massima 1 |
| `trovabandi-night-wide`     | `20 4 * * *`     | 10 chiamate `collect`, `max_pages: 3`, concorrenza massima 1 |
| `trovabandi-maintenance`    | `15 6 * * *`     | 1 chiamata `maintenance`                                     |
| `trovabandi-release-gate`   | `25 6 * * *`     | 1 chiamata `release_gate`; 409 = pipeline non pubblicabile   |
| `trovabandi-morning-digest` | `40 6 * * *`     | chiama a lotti `trovabandi-digest` finché `has_more=false`   |
| `trovabandi-day-1030`       | `30 10 * * *`    | 4 chiamate `collect`, `max_pages: 2`                         |
| `trovabandi-day-1430`       | `30 14 * * *`    | 4 chiamate `collect`, `max_pages: 2`                         |
| `trovabandi-day-1830`       | `30 18 * * *`    | 4 chiamate `collect`, `max_pages: 2`                         |
| `trovabandi-fast-lane`      | `*/30 * * * *`   | 2 chiamate `collect`, `max_pages: 2`; fonti effimere         |
| `trovabandi-urgent-digest`  | `10 * * * *`     | digest a lotti; deduplica gli alert già creati               |

La rotazione delle fonti comprende corsie distinte per: PNRR, Funding & Tenders, EIC/EISMEA,
Digital Europe, Horizon Europe, LIFE/CINEA, FSE+, Interreg, PAC/agricoltura e Creative Europe.
Il PNRR è nazionale/territoriale; i programmi UE diretti restano in ambito `EU` e il matching
controlla Paesi ammissibili e requisiti di consorzio quando presenti nella fonte ufficiale.

## Ricerca guidata dal profilo

Quando il cliente completa o riapre il proprio feed, la PWA accoda una richiesta deduplicata.
Central Core conserva soltanto segnali non identificativi: regione, provincia, prefisso ATECO,
dimensione, aree di investimento e flag femminile/giovanile/innovativa. Ragione sociale, P.IVA,
email, PEC e contatti non entrano nella coda. Il successivo `collect` usa questi segnali per scegliere
fonti territorialmente pertinenti e ampliare la query; il feed applica poi il matching completo e
ordina per stato, punteggio motivato e scadenza.

## Fonti effimere e persistenza della prova

Le fonti `ALBO_PRETORIO`, `CAMERALE` e `GAL` hanno intervallo obiettivo di 30 minuti; `BUR`,
`DECRETO` ed `EU_PORTAL` di 60 minuti. La notte resta dedicata a PDF, allegati e recuperi profondi.
Ogni opportunità salvata conserva estratto, hash, data di acquisizione e URL della prova: se l'ente
rimuove la pagina, l'utente mantiene la scheda e vede che la fonte va riconfermata. Il job rapido va
dimensionato sui limiti Replit/API: una sovrapposizione deve essere saltata, mai eseguita in parallelo.

Tutti i job devono avere timeout per singola chiamata di 180 secondi, retry massimo 1 soltanto su rete/5xx e backoff di 20 secondi. Nessun retry su 2xx, 4xx o 409.

## Contratto del digest

Endpoint: `POST {TROVABANDI_APP_SUPABASE_URL}/functions/v1/trovabandi-digest`

Header: `x-cron-secret: {TROVABANDI_CRON_SECRET}`.

Body iniziale: `{ "offset": 0, "limit": 10 }`. Usare il `next_offset` restituito finché `has_more` è `true`. Il job è completo soltanto quando `failed=0`.

## Gate operativo

Non considerare la mattina pronta se `release_gate` non restituisce 200. Il gate richiede, nelle ultime 26 ore, almeno una scansione `SUCCEEDED` con telemetria provider valida per ciascuna delle fonti abilitate e quindi per ogni `source_kind` abilitato. Una scansione reale con zero risultati è valida: il gate non richiede novità artificiali né `verified_count > 0`. Il catalogo deve comunque contenere opportunità ufficiali, verificate, corredate da evidenza e non scadute; il minimo è dinamico e pari al numero di corsie `source_kind` abilitate. Qualsiasi errore di query chiude il gate con esito negativo.

La rotazione seleziona prima la fonte con `next_scan_at` più vecchio, poi quelle mai scansionate; la priorità decide soltanto gli ex aequo. Un refresh regionale pendente può preferire una fonte della stessa regione (o nazionale) soltanto entro 30 minuti dalla fonte più arretrata: oltre quel limite prevale sempre l'ordine fair, evitando starvation. Una prenotazione ottimistica di 20 minuti impedisce che due job sovrapposti consumino budget sulla stessa fonte. I limiti `max_pages` restano invariati.

Il conteggio del catalogo usa un RPC TrovaBandi isolato con `count(DISTINCT opportunity.id)` ed `EXISTS` sull'evidenza: più prove della stessa opportunità non possono gonfiare il gate.

Registrare per ogni job: ora inizio/fine, azione, status HTTP, stato persistito (`SUCCEEDED`, `PARTIAL`, `FAILED` o `SKIPPED`), discovered, processed, verified, warnings e tentativo. Un run `PARTIAL` conserva contatori e diagnostica, ma risponde HTTP 502 con `ok: false` e `COLLECTION_PARTIAL`, quindi l'orchestratore deve fallire il job. `NO_SOURCE_DUE` deve risultare `SKIPPED`, non `SUCCEEDED`, e non vale come raccolta riuscita. Non registrare URL completi, payload dei profili o secret.
