# Backfill scadenze via fetch di dettaglio (zero costi provider)

## Obiettivo
Recuperare `deadline_at` (e, se emergono, gli importi) sui bandi già in catalogo che ne sono privi, riusando il fetch di dettaglio già in produzione: solo pagine dello stesso dominio ufficiale, tramite il client HTTP interno con SSRF guard. Nessuna chiamata a Firecrawl, Apify o Perplexity.

## Perimetro
- **97 bandi** senza `deadline_at`, tutti con almeno un'evidenza con URL ufficiale valido.
- Ogni bando: massimo **2 fetch di dettaglio** (link dichiarati, poi link scoperti nella pagina).
- Scrittura **solo su campi nulli** (fail-closed), nessuna promozione di stato forzata.

## Esecuzione a lotti
Nuova azione `backfill_detail` in `trovabandi-engine`, invocabile con parametri:

```text
{ "action": "backfill_detail", "limit": 15, "dry_run": true }
```

- **Lotto da 15 bandi** per invocazione (~30 fetch, entro il limite di 12 dettagli/run già presente → il limite viene portato a `limit * 2` solo per questa azione).
- Ordinamento deterministico per `created_at` con cursore su `id`, così i lotti non si sovrappongono.
- Ogni riga elaborata viene marcata con un timestamp di tentativo (`detail_backfill_at`, nuova colonna) per non ripetere gli stessi bandi al lotto successivo e per rendere l'operazione riprendibile.
- Sequenza proposta: 1 lotto in `dry_run` (report senza scritture) → verifica manuale delle proposte → 7 lotti reali da 15, lanciati a mano uno alla volta.
- Nessun cron: l'azione resta manuale finché non è validata.

## Rischi e mitigazioni
| Rischio | Mitigazione |
| --- | --- |
| Timeout della funzione su lotti grandi | Lotto da 15, timeout 20s per fetch, budget di tempo di 90s per run con uscita pulita e cursore salvato |
| Date sbagliate scritte in produzione | Parser deterministici già testati (30 test), contesto di scadenza obbligatorio, finestra da oggi a +36 mesi, merge solo su campi nulli |
| Fetch ripetuti su siti ufficiali | Max 2 per bando, una sola passata complessiva, User-Agent standard già in uso |
| Pagine non raggiungibili / PDF pesanti | Errori tracciati in `diagnostics` come `detail:ERR`, nessuna scrittura, il bando resta invariato |
| Crescita evidenze | Ogni dettaglio salva un solo record con estratto da 3.000 char (~300 KB totali nel caso peggiore) |

## Tempo stimato
- Implementazione azione + colonna di tracciamento + test: ~1 intervento.
- Esecuzione: ~60–90 s per lotto, 8 lotti → **circa 10–12 minuti** complessivi, spalmabili.
- Recupero atteso, prudenziale: **20–40 scadenze** sui 97 (le fonti UE/statali pubblicano il termine nella pagina di dettaglio o nel PDF allegato; le fonti già scadute resteranno correttamente vuote).

## Dettagli tecnici
- File toccati: `supabase/functions/trovabandi-engine/index.ts` (nuovo ramo azione), `persist.ts` (aggiornamento parziale su campi nulli, già presente), migrazione per `trovabandi_opportunities.detail_backfill_at timestamptz`.
- Riuso diretto di `enrichFromDetailPages`, `extractDetailLinks`, `parseDeadline`, `parseAmounts`: nessuna logica duplicata.
- Output di ogni run: `{ processed, fetched, deadlines_written, amounts_written, skipped, diagnostics[] }`, più una riga in `trovabandi_runs` per tracciabilità.
