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
  // ── Padova prima periferia — residenziale ──
  { q: "Comune Vigonza Selvazzano Rubano Albignasego alienazioni immobili residenziali avvisi pubblici", comune: "Vigonza", provincia: "PD", category: "pre_alienation" },
  { q: "Comune Cadoneghe Limena Vigodarzere Noventa Padovana vendita immobili bando asta pubblica", comune: "Cadoneghe", provincia: "PD", category: "pre_alienation" },
  { q: "Comune Abano Terme Montegrotto Terme patrimonio immobiliare cessione alienazione", comune: "Abano Terme", provincia: "PD", category: "pre_alienation" },
  { q: "Ponte San Nicolò Saonara Casalserugo Due Carrare Mestrino immobili vendita pubblica avviso", comune: "Ponte San Nicolò", provincia: "PD", category: "pre_alienation" },
  // ── Padova città — commerciale ──
  { q: "Comune di Padova cessione locali commerciali negozi uffici patrimonio pubblico bando", comune: "Padova", provincia: "PD", category: "commercial" },
  { q: "Padova aste giudiziarie immobili commerciali capannoni uffici tribunale", comune: "Padova", provincia: "PD", category: "asta_commerciale" },
  { q: "Padova prima periferia capannoni industriali commerciali dismissioni aste tribunale Padova", comune: "Padova", provincia: "PD", category: "asta_commerciale" },
  // ── Padova — bandi e agevolazioni ──
  { q: "Regione Veneto bandi acquisto prima casa agevolazioni mutuo Padova provincia 2024 2025", comune: "Padova", provincia: "PD", category: "bando" },
  { q: "Comune Padova bandi ristrutturazione efficientamento energetico incentivi proprietari", comune: "Padova", provincia: "PD", category: "bando" },
  { q: "Comune di Vicenza beni immobili gestione patrimonio avviso",      comune: "Vicenza", provincia: "VI", category: "public_asset" },
  { q: "Comune di Treviso variante piano interventi rigenerazione",       comune: "Treviso", provincia: "TV", category: "zoning_change" },
  { q: "Jesolo rigenerazione urbana patrimonio pubblico avviso",          comune: "Jesolo",  provincia: "VE", category: "urban_regeneration" },
  { q: "Chioggia opere pubbliche mobilità turismo piano",                 comune: "Chioggia",provincia: "VE", category: "public_work" },
  { q: "Veneto manifestazione interesse immobili comunali bando",          comune: "Veneto",  provincia: "VEN", category: "expression_of_interest" },
  // ── Aste tribunale Padova ──
  { q: "aste giudiziarie immobili residenziali Padova tribunale pvp.giustizia.it 2025 2026", comune: "Padova", provincia: "PD", category: "pre_auction_signal" },
  { q: "aste giudiziarie immobili commerciali capannoni Padova provincia tribunale 2025 2026", comune: "Padova", provincia: "PD", category: "pre_auction_signal" },
  { q: "procedura esecutiva immobiliare Padova Vigonza Selvazzano Rubano Albignasego 2025", comune: "Padova", provincia: "PD", category: "pre_auction_signal" },
  // ── Immobili bruciati / fatigue ──
  { q: "immobile invenduto anni Padova centro storico vendesi da tempo prezzo ridotto", comune: "Padova", provincia: "PD", category: "price_fatigue_signal" },
  { q: "vendita immobile urgente Padova provincia proprietario diretto trattabile 2025 2026", comune: "Padova", provincia: "PD", category: "motivated_seller_signal" },
  // ── Successioni e patrimoni ──
  { q: "successione ereditaria immobili Padova provincia atti notarili vendita eredi 2025", comune: "Padova", provincia: "PD", category: "succession_signal" },
  { q: "eredità immobili Vigonza Selvazzano Rubano Albignasego Cadoneghe vendita rapida 2025", comune: "Vigonza", provincia: "PD", category: "succession_signal" },
  // ── Rigenerazione urbana periferia ──
  { q: "rigenerazione urbana piano interventi Padova 2030 microzone quartieri target investimento", comune: "Padova", provincia: "PD", category: "urban_regeneration_signal" },
  { q: "variante urbanistica Selvazzano Dentro Rubano Mestrino Limena cambio destinazione uso 2025", comune: "Selvazzano Dentro", provincia: "PD", category: "zoning_change_signal" },
  // ── Dismissioni enti pubblici ──
  { q: "ATER Padova dismissione patrimonio ERP vendita alloggi sociali 2025 2026", comune: "Padova", provincia: "PD", category: "public_asset_disposal_signal" },
  { q: "Università Padova dismette patrimonio immobiliare vendita edifici storico 2025", comune: "Padova", provincia: "PD", category: "public_asset_disposal_signal" },
  { q: "Ospedale Padova ULSS6 dismissione strutture sanitarie alienazione immobili 2025", comune: "Padova", provincia: "PD", category: "public_asset_disposal_signal" },
];

export interface PerplexityErrorDetail {
  query: string;
  status: number | null;
  message: string;
}

export async function runPerplexityDiscovery(opts: {
  comuni?: string[];
  maxQueries?: number;
}): Promise<{ ok: boolean; hits: DiscoveryHit[]; errors: string[]; errorDetails: PerplexityErrorDetail[] }> {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) {
    console.error("[perplexityDiscovery] PERPLEXITY_API_KEY missing");
    return {
      ok: false, hits: [], errors: ["PERPLEXITY_API_KEY missing"],
      errorDetails: [{ query: "(init)", status: null, message: "PERPLEXITY_API_KEY missing" }],
    };
  }

  const errors: string[] = [];
  const errorDetails: PerplexityErrorDetail[] = [];
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
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        const snippet = bodyText.slice(0, 200);
        console.error(`[perplexityDiscovery] query "${q.q.slice(0, 80)}" HTTP ${res.status}: ${snippet}`);
        errors.push(`${q.q}: HTTP ${res.status}`);
        errorDetails.push({ query: q.q, status: res.status, message: snippet || `HTTP ${res.status}` });
        continue;
      }
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
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[perplexityDiscovery] query "${q.q.slice(0, 80)}" exception: ${msg.slice(0, 200)}`);
      errors.push(`${q.q}: ${msg}`);
      errorDetails.push({ query: q.q, status: null, message: msg.slice(0, 200) });
    }
  }
  return { ok: errors.length === 0 || hits.length > 0, hits, errors, errorDetails };
}
