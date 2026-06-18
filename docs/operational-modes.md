# Modalita' operative — test_intensive vs saving

Tabella di controllo: `public.operational_mode` (singleton `id=1`).

## test_intensive

- Cron pesanti girano **ogni notte** (`heavy_cron_every_n_days = 1`).
- Cap mensile aggregato (Apify+Firecrawl+AI): **$100** (~92€).
- Cap giornaliero Firecrawl: **5000 crediti/pagine**.
- Cap giornaliero AI (somma OpenAI+Anthropic+Perplexity): **$0.50**.
- Tipicamente attivato per una finestra a tempo (es. 7 giorni) per misurare carico/qualita' reali.

## saving (default a regime)

- Cron pesanti girano **ogni 3 giorni** (gate `doy % 3 == 0`).
- Cap mensile: **$50**.
- Cap giornaliero Firecrawl: **2000**.
- Cap giornaliero AI: **$0.20**.
- I giorni "off" il sistema gira solo `padova-light-refresh` (re-score + decay listing) — niente scraping.

## Componenti

| File | Ruolo |
|------|-------|
| `supabase/functions/_shared/operationalMode.ts` | Lettura singleton + `checkAndExpireTestMode()` |
| `supabase/functions/_shared/heavyCronGate.ts` | `shouldRunHeavyCron()` da chiamare all'inizio di ogni cron pesante |
| `supabase/functions/_shared/firecrawlBudget.ts` | `canSpendFirecrawl()` / `recordFirecrawlSpend()` |
| `supabase/functions/_shared/aiBudget.ts` | `canSpendAi()` / `recordAiSpend()` |
| `supabase/functions/_shared/monthlyBudget.ts` | `isMonthlyCapReached()` — kill switch trasversale |
| `supabase/functions/_shared/apifyBudget.ts` | Estesa con check `isMonthlyCapReached()` |
| `supabase/functions/civiko-mode-watchdog` | Cron 15 min: scaduto il test → flippa a saving + log alert |
| `supabase/functions/civiko-budget-status` | Endpoint pubblico per dashboard (EUR, modalita', days_remaining) |

## Avviare manualmente un test di N giorni

```sql
UPDATE public.operational_mode
   SET mode = 'test_intensive',
       test_started_at = now(),
       test_ends_at = now() + interval '7 days',
       monthly_cap_usd = 100,
       firecrawl_daily_cap_credits = 5000,
       ai_daily_cap_usd = 0.50,
       heavy_cron_every_n_days = 1,
       updated_at = now()
 WHERE id = 1;
```

## Rientro automatico

Il cron `civiko-mode-watchdog-15m` chiama l'edge function `civiko-mode-watchdog` ogni
15 minuti. Quando `now() >= test_ends_at`, il watchdog:

1. UPDATE `operational_mode` → `mode='saving'` + cap di risparmio.
2. INSERT in `cron_alerts_pending` (severity `info`) — visibile in dashboard admin.

Idempotente: se la modalita' e' gia' `saving`, no-op.

## Verifica stato

```bash
curl https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-budget-status \
  -H "apikey: $SUPABASE_ANON_KEY"
```

## Note

- I cron NON vengono schedulati/cancellati: restano sempre attivi su pg_cron.
  Il gate fa skip-and-log quando la modalita' richiede di saltare.
- Il cap mensile e' un kill switch: quando raggiunto, qualunque cron pesante
  ritorna immediatamente `{skipped:true, reason:"monthly_cap_reached"}`.
- Baseline mensile inclusa nei totali: Apify 29 USD, Firecrawl 19 USD.
