// ═══════════════════════════════════════════════════════════════
// padovaMicrozonaPerplexity.ts
// Seconda fase di discovery: ricerca Perplexity (sonar) dedicata
// alle microzone prioritarie di Padova. Le chiamate vanno in sequenza
// con pausa di 500ms tra una e l'altra per rispettare i rate limit.
// Nessun dato personale: filtriamo necrologi/anagrafe a valle.
// ═══════════════════════════════════════════════════════════════

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";

export interface MicrozonaHit {
  source_url: string;
  title: string;
  snippet: string;
  microzona_slug: string;    // es. "pd::arcella"
  microzona_label: string;   // es. "Arcella"
  signal_type: "motivated_seller" | "succession";
  confidence: number;
  via: "perplexity_microzona";
}

interface MicrozonaTarget {
  label: string;
  slug: string;
  query: string;
}

// Top-5 priorità (limitiamo per non superare i rate limit di Perplexity).
const TARGETS: MicrozonaTarget[] = [
  { label: "Arcella",                  slug: "pd::arcella",
    query: "vendita immobili privati Arcella Padova 2026 eredità successione proprietario anziano" },
  { label: "Centro Storico",           slug: "pd::centro-storico",
    query: "vendita immobili privati Centro Storico Padova 2026 eredità successione proprietario anziano" },
  { label: "Stanga",                   slug: "pd::stanga",
    query: "vendita immobili privati Stanga Padova 2026 eredità successione proprietario anziano" },
  { label: "Portello",                 slug: "pd::portello",
    query: "vendita immobili privati Portello Padova 2026 eredità successione proprietario anziano" },
  { label: "Sud (Guizza/Bassanello)",  slug: "pd::sud",
    query: "vendita immobili privati Guizza Bassanello Padova 2026 eredità successione proprietario anziano" },
];

const PRIVACY_BLOCKLIST = /necrolog|obituar|funebr|cimiter|anagrafe|stato-civile/i;

function classifySignal(text: string): "motivated_seller" | "succession" {
  const t = text.toLowerCase();
  return /eredit|successio|defunt|de cuius|notarile|asse ereditario/.test(t)
    ? "succession"
    : "motivated_seller";
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface MicrozonaErrorDetail {
  query: string;
  status: number | null;
  message: string;
}

export async function runPadovaMicrozonaDiscovery(): Promise<{
  ok: boolean;
  hits: MicrozonaHit[];
  errors: string[];
  errorDetails: MicrozonaErrorDetail[];
  queries_run: number;
}> {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) {
    console.error("[padovaMicrozonaPerplexity] PERPLEXITY_API_KEY missing");
    return {
      ok: false, hits: [], errors: ["PERPLEXITY_API_KEY missing"],
      errorDetails: [{ query: "(init)", status: null, message: "PERPLEXITY_API_KEY missing" }],
      queries_run: 0,
    };
  }

  const hits: MicrozonaHit[] = [];
  const errors: string[] = [];
  const errorDetails: MicrozonaErrorDetail[] = [];
  let queries_run = 0;

  for (let i = 0; i < TARGETS.length; i++) {
    const t = TARGETS[i];

    // Pausa 500ms fra una chiamata e la successiva (non prima della prima).
    if (i > 0) await sleep(500);

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25_000);
      const res = await fetch(PERPLEXITY_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "sonar",
          messages: [
            {
              role: "system",
              content:
                "Restituisci SOLO URL pubblici (annunci, articoli, avvisi) " +
                "che riguardino vendite immobiliari nella microzona indicata. " +
                "Nessun dato personale, nessun necrologio.",
            },
            { role: "user", content: `${t.query}. Restituisci massimo 5 URL pubblici con titolo e breve snippet.` },
          ],
          max_tokens: 600,
          temperature: 0.1,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      queries_run += 1;

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        const snippet = bodyText.slice(0, 200);
        console.error(`[padovaMicrozonaPerplexity] ${t.label} HTTP ${res.status}: ${snippet}`);
        errors.push(`${t.label}: HTTP ${res.status}`);
        errorDetails.push({ query: t.label, status: res.status, message: snippet || `HTTP ${res.status}` });
        continue;
      }
      const data = await res.json().catch(() => ({}));
      const citations: unknown = data?.citations;
      const content: string = data?.choices?.[0]?.message?.content ?? "";
      const urls: string[] = Array.isArray(citations) ? citations.filter((u) => typeof u === "string") : [];

      for (const url of urls.slice(0, 5)) {
        if (!/^https?:\/\//i.test(url)) continue;
        if (PRIVACY_BLOCKLIST.test(url)) continue;
        const sig = classifySignal(content);
        hits.push({
          source_url: url,
          title: `[${t.label}] ${t.query}`.slice(0, 240),
          snippet: content.slice(0, 240),
          microzona_slug: t.slug,
          microzona_label: t.label,
          signal_type: sig,
          confidence: 0.4,
          via: "perplexity_microzona",
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[padovaMicrozonaPerplexity] ${t.label} exception: ${msg.slice(0, 200)}`);
      errors.push(`${t.label}: ${msg}`);
      errorDetails.push({ query: t.label, status: null, message: msg.slice(0, 200) });
    }
  }

  return { ok: hits.length > 0 || errors.length === 0, hits, errors, errorDetails, queries_run };
}
