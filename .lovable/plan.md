# pipeline_0510_capped — run unico sui 4 portali con tetto di costo rigido

## Cosa dice il codice reale (sola lettura, nessuna modifica fatta)

**Composizione di `pipeline_0510`** (`civiko-orchestrator-dispatch/index.ts`): un solo stage `["apify_batch", "portal_casa"]`.
- `apify_batch` → `civiko-padova-apify-launch-batch`, che chiama in sequenza 4 wrapper: `cron-apify-immobiliare-nightly`, `cron-apify-idealista-nightly`, `cron-apify-subito-nightly`, `civiko-private-leads-nightly`. Il batch **rifiuta per contratto qualunque override** (body hardcoded `{}`), quindi oggi non esiste alcun modo di ridurre i volumi dall'esterno.
- `portal_casa` → `enqueue-padova-portal-scrapes` (`max_pages: 5`), coda interna, non Apify.

**Actor e input cap disponibili**
| Portale | Actor | Input di volume | Default wrapper |
|---|---|---|---|
| immobiliare | `azzouzana~immobiliare-it-listing-page-scraper-by-search-url` (discover) + `memo23~immobiliare-scraper` (detail) | `maxItems` per run, 4 search URL | `desired_results: 300`, `max_items: 800` |
| idealista | actor unico (`Property_urls`, `desiredResults`) | `desired_results`, `max_urls_from_db`, `max_items` | 200 / 200 / 400 |
| subito | `emastra~subito-it-immobili` | `maxResultItems` (clamp 1..1000) | `max_items: 300` |

I tre wrapper cron **accettano override dal body** (`{ ...defaults, ...overrides }`): i cap sono quindi già iniettabili, manca solo un chiamante Civiko che li imposti.

**Stime di costo hardcoded**
- immobiliare: `estUsd 0.20` per ciascuna delle 4 search URL discover + `0.30` detail → ~1.10 USD a run.
- idealista: `estUsd 0.50` fisso.
- subito: `estUsd = max_items * 5 / 1000` (300 item → 1.50 USD), l'unico realmente proporzionale.
- Totale attuale stimato: **~3.1 USD** per run 0510 (più il costo reale pay-per-result, che i primi due non modellano).

**Guardie esistenti** (`_shared/apifyBudget.ts`): cap giornaliero `APIFY_DAILY_CAP_USD` (default 10) e mensile `APIFY_MONTHLY_CAP_USD` (default 60), più l'hard cap EUR del radar. Sono guardie **cumulative di piattaforma**, non un tetto per singolo run: non impediscono che questo run bruci più del previsto.

**Abort automatico per spesa: oggi assente.** `startApifyRun` chiama `POST /v2/acts/{id}/runs?token&waitForFinish=0` e non passa nessuna run option. Apify espone `maxTotalChargeUsd`, `timeout` e `memory` come query param di avvio: sono la leva reale per l'abort lato provider e non è mai usata nel codice.

**Cap minimo semanticamente valido per il gate** (`release_gate`, blocco `fourPortalCurrentRunEvidence`): il gate richiede, per l'esatto ultimo 0510, un `run_id` per ciascuna delle 3 famiglie Apify, ciascuna con `status SUCCEEDED`, `errors_count 0` e `items >= 0` (accetta `zero_novelty`), più la coda Casa completa e `collect_pending` senza errori. **Non c'è alcuna soglia sul numero di item.** Il cap più piccolo valido è quindi quello che garantisce dataset non vuoti per robustezza, non per contratto: **25 item per portale**.

## Proposta: azione additiva `pipeline_0510_capped`

Solo Civiko, fail-closed, additiva. `pipeline_0510` resta byte-identica; UEradar, contratti condivisi, `_shared/*` e i wrapper esistenti non vengono toccati.

1. **Nuova Edge Function `civiko-padova-apify-launch-batch-capped`** (copia isolata, il batch attuale resta intatto). Differenze:
   - budget di run dichiarato e costante: `RUN_COST_CAP_USD = 1.00`;
   - profilo di cap hardcoded (non accetta override dal client): immobiliare `desired_results 25 / max_items 25` su **1 sola search URL**, idealista `desired_results 25 / max_urls_from_db 25 / max_items 25`, subito `max_items 25`;
   - stima preventiva per portale, accumulo e **stop prima del lancio** se il totale supererebbe il cap → risposta `402 cost_cap_would_exceed` senza chiamare Apify;
   - echo obbligatorio nell'envelope: `cost_cap_usd`, `estimated_cost_usd`, `per_portal_estimates[]`, `caps_applied{}`, `run_id`/`dataset_id` per portale;
   - se un portale non restituisce identificatori o supera il cap, si ferma: nessun lancio parziale silenzioso.

2. **Abort automatico per spesa lato provider**: passaggio di `maxTotalChargeUsd` + `timeout` all'avvio del run, tramite un helper locale alla funzione capped (non modificando `_shared/apify.ts`). Se il token/actor non supporta il parametro, il run **non parte** (fail-closed) invece di partire senza tetto.

3. **Nuova azione orchestratore `pipeline_0510_capped`**: stage unico `["apify_batch_capped", "portal_casa"]`, con `portal_casa` invariato ma `max_pages: 2`. Registrata in allowlist accanto alle esistenti, senza rimuovere né rinominare nulla; nessun cron creato o attivato.

4. **Release gate invariato**: l'audit scrive `pipeline_0510_capped` come pipeline propria. Va deciso esplicitamente un punto (vedi sotto) prima di implementare.

5. **Test** (nessuna esecuzione provider): cap rispettati e echati; superamento cap → 402 senza fetch Apify; portale senza identificatori → fail-closed; profilo cap non sovrascrivibile dal body; `pipeline_0510` originale non modificata.

## Decisione necessaria prima di implementare

Il gate correla l'evidenza a `latestRunActionResult("pipeline_0510", ...)`. Con una pipeline dal nome nuovo il gate **non vedrà** il run capped e resterà BLOCKED. Due strade:
- **A** — il capped scrive audit con action name `pipeline_0510` (gate chiuso davvero, ma la distinzione resta solo nei counters);
- **B** — si estende il gate ad accettare `pipeline_0510` *oppure* `pipeline_0510_capped` (più esplicito, ma tocca il gate).

Nessuna delle due è già scelta: serve la tua indicazione.

## Vincoli rispettati

Nessuna modifica, nessun deploy, nessuna migrazione, nessun provider e nessun cron eseguiti in questa fase: questo documento è il risultato della sola ispezione.
