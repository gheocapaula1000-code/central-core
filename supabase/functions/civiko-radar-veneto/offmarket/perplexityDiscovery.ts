// ═══════════════════════════════════════════════════════════════
// Perplexity Discovery — usa Perplexity SOLO per scoprire URL pubblici
// candidati. Non usare la risposta AI come prova. Le pagine devono
// essere verificate da Firecrawl/direct_fetch a valle.
// ═══════════════════════════════════════════════════════════════

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";

export interface DiscoveryHit {
  source_url: string;
  title: string;
  snippet: string;
  comune: string;
  provincia: string;
  category: string;
  confidence: number;
  via: "perplexity_discovery";
}

export function perplexityAvailable(): boolean {
  return !!Deno.env.get("PERPLEXITY_API_KEY");
}

const QUERIES: Array<{ q: string; comune: string; provincia: string; category: string }> = [
  { q: "Comune di Verona alienazione beni immobili sito istituzionale",  comune: "Verona",  provincia: "VR", category: "pre_alienation" },
  { q: "Comune di Venezia dismissioni patrimoniali immobili sito ufficiale", comune: "Venezia", provincia: "VE", category: "pre_alienation" },
  { q: "Comune di Padova patrimonio immobiliare alienazioni avviso",      comune: "Padova",  provincia: "PD", category: "pre_alienation" },
  { q: "Comune di Vicenza beni immobili gestione patrimonio avviso",      comune: "Vicenza", provincia: "VI", category: "public_asset" },
  { q: "Comune di Treviso variante piano interventi rigenerazione",       comune: "Treviso", provincia: "TV", category: "zoning_change" },
  { q: "Jesolo rigenerazione urbana patrimonio pubblico avviso",          comune: "Jesolo",  provincia: "VE", category: "urban_regeneration" },
  { q: "Chioggia opere pubbliche mobilità turismo piano",                 comune: "Chioggia",provincia: "VE", category: "public_work" },
  { q: "Veneto manifestazione interesse immobili comunali bando",          comune: "Veneto",  provincia: "VEN", category: "expression_of_interest" },
];

export async function runPerplexityDiscovery(opts: {
  comuni?: string[];
  maxQueries?: number;
}): Promise<{ ok: boolean; hits: DiscoveryHit[]; errors: string[] }> {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) return { ok: false, hits: [], errors: ["PERPLEXITY_API_KEY missing"] };

  const errors: string[] = [];
  const hits: DiscoveryHit[] = [];
  const comuniLow = (opts.comuni ?? []).map((c) => c.toLowerCase());
  const filtered = comuniLow.length > 0
    ? QUERIES.filter((q) => comuniLow.includes(q.comune.toLowerCase()) || q.comune === "Veneto")
    : QUERIES;
  const max = Math.max(1, Math.min(opts.maxQueries ?? 6, filtered.length));

  for (const q of filtered.slice(0, max)) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 25_000);
      const res = await fetch(PERPLEXITY_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "sonar",
          messages: [
            { role: "system", content: "Restituisci SOLO URL istituzionali italiani pubblici (.gov.it, comune, regione, demanio). Nessun dato personale." },
            { role: "user", content: `${q.q}. Restituisci massimo 5 URL pubblici istituzionali con titolo e breve snippet.` },
          ],
          search_domain_filter: ["comune.padova.it","padovanet.it","comune.venezia.it","comune.verona.it","comune.vicenza.it","comune.treviso.it","comune.belluno.it","comune.rovigo.it","comune.jesolo.ve.it","chioggia.org","abanoterme.net","regione.veneto.it","bandi.regione.veneto.it","agenziademanio.it"],
          max_tokens: 600,
          temperature: 0.1,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) { errors.push(`${q.q}: HTTP ${res.status}`); continue; }
      const data = await res.json().catch(() => ({}));
      const citations: string[] = Array.isArray(data?.citations) ? data.citations : [];
      const content: string = data?.choices?.[0]?.message?.content ?? "";
      // Estrai snippet brevi per ogni URL citato
      for (const url of citations.slice(0, 5)) {
        if (typeof url !== "string" || !/^https?:\/\//.test(url)) continue;
        // privacy: skip necrologi/personali
        if (/necrolog|obituar|funebr|cimiter|anagrafe|stato-civile/i.test(url)) continue;
        hits.push({
          source_url: url,
          title: q.q,
          snippet: content.slice(0, 240),
          comune: q.comune, provincia: q.provincia,
          category: q.category, confidence: 0.5,
          via: "perplexity_discovery",
        });
      }
    } catch (e) {
      errors.push(`${q.q}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: errors.length === 0 || hits.length > 0, hits, errors };
}
