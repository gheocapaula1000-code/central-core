# TrovaBandi — scheduler pg_cron (Europe/Rome)

Lo scheduler di produzione è **pg_cron sul live Core** Lovable Cloud
`jpunnzgixcghuydstdlt` (`https://jpunnzgixcghuydstdlt.supabase.co`).
La PWA UERADAR è un client sottile. Non usare il progetto org vuoto
`egjvullvkwpzyyworeml` / `central-core-prod`.

Il roster a 10 agenti descritto in documentazione UERADAR
(`docs/scraping-agents.md`: Local, Camerale, Regionale, Nazionale, PNRR,
UE, Femminile, Giovanile, PDF, Dynamic) **non è un set di edge function
separate**. In questo repo c'è un solo motore (`trovabandi-engine`) e
le corsie sono `lane` sul `collect` notturno.

## Azioni consentite

- `collect`: seleziona una fonte dovuta (eventualmente filtrata per `lane`),
  scopre candidati, estrae al massimo `max_pages` documenti e persiste prove.
  `allow_paid: false` = solo seed listing + HTTP ufficiale + excerpt già
  persistito. `dry_run: true` = selezione fair senza lease, provider o
  scritture.
- `backfill_nulls`: riempie scadenza, importi, ATECO, URL domanda / modulistica e PEC
  sulle righe già in catalogo. Preferisce `raw_excerpt` / HTTP ufficiale.
  Default `dry_run: true`. I cron di produzione passano `dry_run: false`
  e `allow_paid_extract: false`. Non ricrawla `bur.regione.fvg.it`.
- `enrich_apply_urls`: one-shot fail-closed sulle righe `official_source`
  già in catalogo. Legge la pagina ufficiale (e il `notice_url` se serve)
  e persiste soltanto `forms_url` (modulistica / PDF) e `application_url`
  (presenta la domanda / piattaforma) se il link è https sullo stesso
  dominio e ha un'etichetta chiara. Le homepage (Invitalia/GSE) non
  vengono copiate in `forms_url`. Default `dry_run: true`.
  Non tocca BUR FVG (`bur.regione.fvg.it`, hang noto). Invocare sul live
  Core `jpunnzgixcghuydstdlt`, mai su `central-core-prod` vuoto:

```bash
# dry-run: conta quanti official guadagnerebbero un URL reale
curl -sS -X POST "$CENTRAL_CORE_API_URL/functions/v1/trovabandi-engine" \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: $CENTRAL_CORE_JOB_SECRET" \
  -d '{"action":"enrich_apply_urls","dry_run":true,"max_batch":40}'

# scrittura: ripetere finché remaining=0
curl -sS -X POST "$CENTRAL_CORE_API_URL/functions/v1/trovabandi-engine" \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: $CENTRAL_CORE_JOB_SECRET" \
  -d '{"action":"enrich_apply_urls","dry_run":false,"max_batch":16}'
```

  Il feed PWA espone `forms_url` anche come `modulistica_url`. Nessuna
  colonna nuova: si usano `forms_url` e `application_url` già in tabella.

### Quanti dei 442 official avrebbero un `forms_url` reale

Conteggio live (Paula, 2026-08-21) su `trovabandi_opportunities`:

| Bucket | N |
| --- | --- |
| official rows | 442 |
| `forms_url` non null | 60 |
| di cui distinti da `official_url` | 31 |
| `forms_url` = `official_url` (copia landing) | 29 |
| `forms_url` null | 382 |
| `application_url` non null | 103 |
| di cui distinti da official/notice | 40 |

Il parser è fail-closed: **non inventa modulistica**. Quindi:

- **Già un URL distinto (31):** restano solo se non sono a loro volta homepage/FAQ. Altrimenti vengono svuotati.
- **Copie landing (29):** non restano in `forms_url`. Restano vuoti, salvo un link etichettato *diverso* sulla pagina.
- **Null (382):** restano vuoti se la pagina è indice/homepage/FAQ/newsletter/video-chrome, oppure se l'avviso non pubblica un form. Solo una scheda candidato con link etichettato guadagna un `forms_url`.
- **Stima onesta senza fetch delle 442 pagine:** la maggioranza resta vuota. Il feed PWA da 74 matched ha già 5 sole landing HTML come modulistica e molti non-avvisi; quelli restano vuoti di proposito.
- **Upper bound dei *nuovi* `forms_url`:** le sole schede `candidate` (non junk listing) che pubblicano un PDF/modulo o “presenta la domanda”. Non è un numero inventabile da URL.

Classifica read-only (nessun fetch, nessun write, non `central-core-prod`):

```sql
SELECT
  count(*) FILTER (
    WHERE official_url ~* '(:\/\/[^\/]+\/?$)|\/(index(\.html|\.php)?|home|homepage|faq|faqs|newsletter|bandi|avvisi|incentivi|contributi)\/?$'
  ) AS junk_or_index_url,
  count(*) FILTER (
    WHERE forms_url IS NOT NULL AND forms_url IS DISTINCT FROM official_url
  ) AS forms_distinct_from_official,
  count(*) FILTER (
    WHERE forms_url IS NOT NULL AND forms_url = official_url
  ) AS forms_copied_official,
  count(*) FILTER (WHERE forms_url IS NULL) AS forms_null
FROM public.trovabandi_opportunities
WHERE official_source;
```

`enrich_apply_urls` dry-run riporta `catalog_junk_listing`, `catalog_candidates`, `already_distinct_forms`, `would_gain_or_gained`, `stay_empty`. Collect non persiste più homepage/FAQ/newsletter/index come opportunità (`SKIPPED_INDEX_LISTING`).
- `maintenance`: marca SCADUTO i bandi con termine passato e chiude i run
  `RUNNING` bloccati da oltre 20 minuti.
- `release_gate`: copertura 26h di tutte le fonti abilitate.
- `status`: stato sintetico senza segreti.

Endpoint: `POST {CENTRAL_CORE_API_URL}/functions/v1/trovabandi-engine`

Header server-to-server (stesso valore, mai loggato):

- `x-internal-secret` (canonico, usato dai cron live)
- `x-job-secret` (alias, stesso `CENTRAL_CORE_JOB_SECRET` del vault;
  `AI_CORE_SECRET_TROVABANDI` resta accettato se presente)

## Orari di produzione (Europe/Rome)

pg_cron è in **UTC**. In ora legale (CEST, UTC+2) gli orari Rome sono
quelli in tabella. In ora solare (CET, UTC+1) slittano di un'ora prima.

| Job | Cron UTC | Europe/Rome (CEST) | Azione | Paid? |
| --- | -------- | ------------------ | ------ | ----- |
| `trovabandi-night-backfill` | `10 23 * * *` | 01:10 | `backfill_nulls` max 16, no paid extract | **FREE** |
| `trovabandi-night-locale` | `20 23 * * *` | 01:20 | `collect` lane=locale, max_pages 3 | paid last-resort |
| `trovabandi-night-camerale` | `30 23 * * *` | 01:30 | `collect` lane=camerale | paid last-resort |
| `trovabandi-night-regionale` | `40 23 * * *` | 01:40 | `collect` lane=regionale (BUR / FESR) | paid last-resort |
| `trovabandi-night-nazionale` | `50 23 * * *` | 01:50 | `collect` lane=nazionale (Invitalia/MIMIT) | paid last-resort |
| `trovabandi-night-pnrr` | `0 0 * * *` | 02:00 | `collect` lane=pnrr (separato da UE) | paid last-resort |
| `trovabandi-night-ue` | `10 0 * * *` | 02:10 | `collect` lane=ue | paid last-resort |
| `trovabandi-night-femminile` | `20 0 * * *` | 02:20 | `collect` lane=femminile | paid last-resort |
| `trovabandi-night-giovanile` | `30 0 * * *` | 02:30 | `collect` lane=giovanile | paid last-resort |
| `trovabandi-night-wide-due` | `20 2 * * *` | 04:20 | `collect` dovuti residui, max_pages 2 | paid last-resort |
| `trovabandi-maintenance` | `15 4 * * *` | 06:15 | `maintenance` | **FREE** |
| `trovabandi-release-gate` | `25 4 * * *` | 06:25 | `release_gate` | **FREE** |
| `trovabandi-day-backfill` | `30 8 * * *` | 10:30 | `backfill_nulls` max 10 | **FREE** |
| `trovabandi-day-cheap` | `30 12 * * *` | 14:30 | `collect` allow_paid=false | **FREE** |

Non esiste un full-scan diurno ogni 4 ore né un collect ogni 20 minuti.
Un job `RUNNING` blocca gli slot paid del collect successivo (cap
concorrenza = 1). Ogni collect ha al massimo 1 coppia di search paid,
1 scrape paid, 1 extract paid — e solo se l'HTTP ufficiale fallisce o
il documento non è leggibile.

## Regole di spesa

- Seed listing + HTTP ufficiale (HTML/PDF/CSV) + `raw_excerpt` già
  persistito: sempre gratis.
- Firecrawl / Apify / Perplexity: solo se il fetch ufficiale fallisce o
  il testo è illeggibile (< 200 caratteri).
- Nessun recrawl di `SCADUTO`.
- Nessuna re-estrazione a pagamento di `VERIFICATO` con scadenza+importo.
- Dedup canonico dei candidati prima dello scrape.
- Preferire `backfill_nulls` sulle ~righe incomplete prima di scoprire
  nuovi URL rumorosi.

## Ricerca guidata dal profilo

Quando il cliente completa o riapre il proprio feed, la PWA accoda una
richiesta deduplicata. Central Core conserva soltanto segnali non
identificativi. Ragione sociale, P.IVA, email, PEC e contatti non
entrano nella coda.

## Fonti e matching fail-closed

Le fonti `ALBO_PRETORIO`, `CAMERALE` e `GAL` restano corsia `locale` /
`camerale`. PNRR è nazionale/territoriale; i programmi UE diretti restano
`ue`. Il matching non marca mai `COMPATIBILE` se ATECO, forma, dimensione
o testo ufficiale sono insufficienti (`DA_VERIFICARE` / `PARZIALE`).

Timeout per chiamata 180 secondi. Retry massimo 1 soltanto su rete/5xx.
`NO_SOURCE_DUE` = `SKIPPED`. Un run `PARTIAL` risponde HTTP 502.

## Gate operativo

Non considerare la mattina pronta se `release_gate` non restituisce 200.
Una scansione reale con zero risultati è valida, incluso
`SKIPPED_CACHE` / `SKIPPED_BUDGET` (collect cheap completato senza
provider a pagamento).
