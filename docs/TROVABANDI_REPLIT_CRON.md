# TrovaBandi — pipeline Replit (Europe/Rome)

La Reserved VM Replit è l'unico scheduler. Lovable serve la PWA; Central Core conserva ed espone il catalogo.

## Azioni consentite

Replit può chiamare soltanto:

- `collect`: seleziona una fonte dovuta, scopre candidati, estrae al massimo `max_pages` documenti e persiste prove e risultato.
- `maintenance`: marca come scaduti i bandi con termine passato.
- `release_gate`: certifica catalogo attivo, run recenti e scansione di almeno una fonte profonda.
- `status`: stato sintetico senza segreti.

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

Non considerare la mattina pronta se `release_gate` non restituisce 200. Registrare per ogni job: ora inizio/fine, azione, status HTTP, discovered, processed, verified, warnings e tentativo. Non registrare URL completi, payload dei profili o secret.

## Runtime hardening (selezione fonti, run SKIPPED, gate dinamico)

Selezione equa: `collect` sceglie sempre la fonte abilitata con `next_scan_at` più vecchio, poi quella
mai scansionata (o con `last_scanned_at` più remoto); la priorità interviene solo a parità. La cadenza
rapida resta garantita perché una fonte a intervallo breve torna dovuta prima delle altre. Una
richiesta di refresh regionale può anticipare una fonte della regione richiesta soltanto se il suo
ritardo dista al massimo 30 minuti dalla fonte più arretrata: nessuna fonte può restare indietro.

Lease ottimistico: prima di lavorare, la fonte viene prenotata con un confronto sul valore osservato di
`next_scan_at`. Se un altro worker l'ha già presa, la chiamata risponde `200` con
`status: "SKIPPED"`, `error_code: "LEASE_LOST"` e non esegue alcun provider.

Esiti di `collect`:

- `dry_run: true` è realmente in sola lettura: nessun provider, nessun run, nessuna scrittura. Ritorna
  `would_collect`, `reason` e il numero di fonti dovute.
- Nessuna fonte dovuta in modalità live: viene persistito un run `SKIPPED` con
  `error_code: "NO_SOURCE_DUE"` e `finished_at`. Un `SKIPPED` non è mai un `SUCCEEDED` e non concorre
  alla copertura del gate.
- I cap su `max_pages` restano 1..5.

Manutenzione: `maintenance` riconcilia i run rimasti `RUNNING` da più di 20 minuti in `FAILED` con
`error_code: "STALE_RUN_TIMEOUT"`, poi scade solo le opportunità in stato appropriato. Entrambe le
scritture sono fail-closed.

Gate dinamico: `release_gate` non usa soglie commerciali. Richiede, con finestra di copertura di 26 ore:

- tutte le fonti abilitate coperte da uno scan reale;
- tutti i `source_kind` abilitati coperti;
- nessun run `RUNNING` stale;
- catalogo ufficiale VERIFICATO attivo con prova documentale almeno pari al numero dinamico di
  `source_kind` abilitati (conteggio DISTINCT via RPC dedicata, mai un join).

Uno scan reale è valido anche a zero novità, purché il run sia `SUCCEEDED`, legato a una fonte, con
entrambi gli status provider `OK` e contatori pagine interi e coerenti. Qualsiasi query in errore o
nulla fa fallire il gate.
