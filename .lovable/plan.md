# TrovaBandi — diagnosi sola lettura run 11:24:04Z – 11:25:55Z

Nessuna modifica a codice, database, deploy; nessuna chiamata a trovabandi-engine, Firecrawl, Perplexity o Apify. Nessun segreto o contenuto mostrato.

## Evidenze osservabili

Otto run `collect` in `trovabandi_runs`, tutti `status = SUCCEEDED`, tutti `error_code = null`, tutti `warnings = []` (array vuoto):

| Inizio (UTC) | Fine (UTC) | discovered | processed | verified | provider_usage |
| --- | --- | --- | --- | --- | --- |
| 11:24:04 | 11:24:11 | 15 | 0 | 0 | firecrawl_search 8, perplexity_search 7, pages_scraped 1 |
| 11:24:13 | 11:24:33 | 12 | 0 | 0 | firecrawl_search 8, perplexity_search 8, pages_scraped 1 |
| 11:24:46 | 11:24:48 | 0 | 0 | 0 | tutti 0 |
| 11:24:49 | 11:25:02 | 13 | 0 | 0 | firecrawl_search 8, perplexity_search 8, pages_scraped 1 |
| 11:25:03 | 11:25:12 | 16 | 0 | 0 | firecrawl_search 8, perplexity_search 8, pages_scraped 1 |
| 11:25:14 | 11:25:29 | 13 | 0 | 0 | firecrawl_search 8, perplexity_search 8, pages_scraped 1 |
| 11:25:31 | 11:25:41 | 8 | 0 | 0 | firecrawl_search 0, perplexity_search 8, pages_scraped 1 |
| 11:25:42 | 11:25:54 | 16 | 0 | 0 | firecrawl_search 8, perplexity_search 8, pages_scraped 1 |

Log Edge di `trovabandi-engine` nella finestra: solo righe `booted` / `Listening on http://localhost:9999/` / `shutdown` (11:24:33, 11:24:45, 11:24:48, 11:24:49, 11:25:02 ×2, 11:25:12, 11:25:13, 11:25:29, 11:25:30, 11:25:41 ×2, 11:25:55). Nessuna riga di errore, nessun log applicativo: la funzione non emette `console.log/warn/error` in nessun punto del percorso collect.

Fatti aggiuntivi verificati nel codice:

- `pages_scraped` è `hits.length`, cioè il numero di candidati effettivamente tentati dopo `slice(0, max_pages)`. Valore 1 in tutti i run: **è stato tentato un solo documento per run**, indipendentemente dai 8–16 candidati scoperti.
- Il run 11:24:46 → 11:24:48 ha `discovered = 0` e provider a 0: nessun candidato trovato, nessun tentativo. Non è un caso di estrazione.
- La versione in esecuzione in quella finestra era quella **precedente** al deploy odierno: non registrava né `warnings` per fase né il campo `diagnostics`. Per questo tutti i `warnings` sono vuoti.

## Conclusione

Con le sole evidenze disponibili **non è possibile distinguere** tra le ipotesi (a) Perplexity non-2xx/timeout/JSON non valido, (b) risposta valida con `is_opportunity = false`, (c) errore di upsert DB.

Motivo dichiarato esplicitamente: la build attiva durante quei run non produceva alcun segnale osservabile per le fasi scrape → extract → store. Non ci sono log applicativi, `warnings` è vuoto, `error_code` è nullo e non esisteva ancora la diagnostica per fase/codice. Qualsiasi attribuzione a (a), (b) o (c) sarebbe un'invenzione.

Unico elemento discriminante già osservabile: `pages_scraped = 1` prova che la fase di ricerca ha funzionato e che almeno un documento è stato tentato in 7 run su 8 — quindi il punto di caduta è a valle della discovery, ma non è determinabile quale dei tre.

## Passi proposti (nessuno eseguito ora)

1. Eseguire, quando la proprietaria lo ritiene opportuno, **due soli** `collect` diagnostici con `max_pages: 2` sulla build attualmente deployata, che registra `diagnostics` per fase e codice.
2. Rileggere in sola lettura `trovabandi_runs` per gli stessi run e leggere i contatori:
   - `scrape:NO_CONTENT` → caduta a monte dell'estrazione;
   - `extract:HTTP_ERROR` / `extract:TIMEOUT` / `extract:PARSE_FAILED` → ipotesi (a);
   - `extract:NOT_OPPORTUNITY` → ipotesi (b);
   - `store:REJECTED` → ipotesi (c).
3. Solo dopo aver letto codici reali, decidere l'eventuale correzione. Nessuna modifica prima di quella evidenza.

## Note tecniche

- Tabella consultata: `trovabandi_runs` (`status`, `error_code`, `discovered_count`, `processed_count`, `verified_count`, `warnings`, `provider_usage`, `started_at`, `finished_at`).
- Log consultati: Edge Function logs di `trovabandi-engine`.
- Nessun URL completo, contenuto scaricato o valore di secret è stato letto o riportato.
