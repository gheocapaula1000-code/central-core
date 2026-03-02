function makeDebugId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
function withAbort(ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

const LOVABLE_SUFFIXES = [".lovable.app", ".lovableproject.com", ".lovable.dev"];
function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  const o = origin.toLowerCase();
  try {
    const u = new URL(o);
    if (u.hostname === "localhost" || u.hostname.startsWith("127.")) return true;
  } catch { /* not a valid URL */ }
  if (LOVABLE_SUFFIXES.some((s) => o.endsWith(s)) || o === "https://lovable.dev") return true;
  const allowed = (Deno.env.get("CORE_ALLOWED_ORIGINS") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return allowed.includes("*") || allowed.includes(o);
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin) ? origin : "null",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-internal-secret, x-app-secret, x-core-secret, x-source-app, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function jsonResponse(req: Request, status: number, body: unknown, debugId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "x-debug-id": debugId },
  });
}
function okResponse(req: Request, data: unknown, debugId: string): Response {
  return jsonResponse(req, 200, { ok: true, data, warnings: [], debug_id: debugId }, debugId);
}
function errResponse(req: Request, status: number, code: string, message: string, debugId: string): Response {
  return jsonResponse(req, status, { ok: false, data: null, warnings: [], debug_id: debugId, error: { code, message } }, debugId);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function checkAuth(req: Request, debugId: string): Response | null {
  const expected = Deno.env.get("AI_CORE_SECRET") ?? "";
  if (!expected) return errResponse(req, 500, "CONFIG_ERROR", "AI_CORE_SECRET not configured", debugId);
  const incoming =
    req.headers.get("x-internal-secret") ??
    req.headers.get("x-app-secret") ??
    req.headers.get("x-core-secret") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "") ?? "";
  if (!incoming) return errResponse(req, 401, "APP_SECRET_REQUIRED", "Missing x-internal-secret", debugId);
  if (!constantTimeEqual(incoming, expected)) return errResponse(req, 401, "APP_SECRET_REJECTED", "Invalid secret", debugId);
  return null;
}

const PIPELINES: Record<string, { maxTokens: number; temperature: number }> = {
  wyloni_bandi:        { maxTokens: 1500, temperature: 0.3 },
  wyloni_bonus:        { maxTokens: 1500, temperature: 0.3 },
  pratica_legal:       { maxTokens: 900,  temperature: 0.4 },
  keydraft_realestate: { maxTokens: 1800, temperature: 0.3 },
};
function getPipeline(domain: string) {
  return PIPELINES[domain] ?? PIPELINES["wyloni_bandi"];
}

const TASK_TOKEN_OVERRIDES: Record<string, number> = {
  feasibility_lab: 2000,
  alchemist: 1600,
  viral_content_bundle: 2500,
  ai_bandi: 2000,
  contratto_analisi: 2000,
};

const WEB_TASKS = new Set([
  "search_grants", "deep_search", "distress_radar", "market_glitch",
  "deep_recovery", "find_contacts", "find_company_contacts", "real_estate_deep", "ai_bandi",
]);

const EMPTY_RESULTS: Record<string, string> = {
  real_estate_deep:      `{"properties":[]}`,
  search_grants:         `{"success":true,"results":[]}`,
  deep_search:           `{"success":true,"newsCards":[]}`,
  distress_radar:        `{"success":true,"signals":[]}`,
  market_glitch:         `{"success":true,"glitches":[]}`,
  deep_recovery:         `{"success":true,"credits":[]}`,
  find_contacts:         `{"results":[]}`,
  find_company_contacts: `{"success":true,"contact":null}`,
  ai_bandi:              `{"ok":true,"confidence_score":0,"data":{"summary_3_lines":["Nessun dato disponibile al momento"],"checklist_documents":[],"questions_to_ask":[],"risks_and_attention":[],"next_steps":[],"sources":[],"confidence_notes":"Perplexity non disponibile"}}`,
};

async function callOpenAI(prompt: string, temperature: number, maxTokens: number): Promise<string> {
  const key = Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPENAI_KEY") ?? "";
  if (!key) throw new Error("OPENAI_API_KEY not configured");
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
  const { signal, clear } = withAbort(28_000);
  const t = Date.now();
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
      signal,
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const output: string = data?.choices?.[0]?.message?.content ?? "";
    if (!output) throw new Error("OpenAI empty output");
    console.log(`[openai] ok latency=${Date.now()-t}ms output_len=${output.length}`);
    return output;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error("OpenAI timeout");
    throw e;
  } finally { clear(); }
}

async function callAnthropic(prompt: string, temperature: number, maxTokens: number): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-3-haiku-20240307";
  const { signal, clear } = withAbort(28_000);
  const t = Date.now();
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: [{ role: "user", content: prompt }] }),
      signal,
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const output: string = data?.content?.[0]?.text ?? "";
    if (!output) throw new Error("Anthropic empty output");
    console.log(`[anthropic] ok latency=${Date.now()-t}ms output_len=${output.length}`);
    return output;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error("Anthropic timeout");
    throw e;
  } finally { clear(); }
}

const PERPLEXITY_SYSTEM: Record<string, string> = {
  real_estate_deep:
    "Sei un agente immobiliare italiano con accesso al web. " +
    "FORMATO RISPOSTA OBBLIGATORIO - rispondi SEMPRE e SOLO in questo JSON:\n" +
    "{\"properties\":[{\"id\":\"1\",\"title\":\"titolo\",\"type\":\"vendita\",\"category\":\"asta\",\"price\":150000,\"pricePerSqm\":1800,\"location\":{\"city\":\"Milano\",\"province\":\"MI\",\"region\":\"Lombardia\",\"zone\":\"\"},\"details\":{\"sqm\":80,\"rooms\":3,\"bathrooms\":1,\"floor\":\"\"},\"features\":[],\"source\":\"pvp.giustizia.it\",\"sourceType\":\"tribunale\",\"url\":\"https://pvp.giustizia.it/pvp/it/detail_inserzione.page?cod_inserzione=XXX\",\"discoveredAt\":\"2026-03-01\",\"discount\":30,\"notes\":\"Asta tribunale\"}]}\n\n" +
    "MODALITÀ STANDARD (filters.category=standard): " +
    "Cerca su Idealista.it, Immobiliare.it, Casa.it. category=standard, sourceType=agenzia-locale.\n\n" +
    "MODALITÀ HIDDEN OPPORTUNITIES (filters.searchMode=hidden_opportunities): " +
    "⛔ VIETATO ASSOLUTAMENTE usare: Idealista, Immobiliare.it, Casa.it, Subito.it, Wikicasa, Tecnocasa, RE/MAX, o qualsiasi portale immobiliare standard.\n" +
    "✅ USA SOLO queste fonti specializzate:\n" +
    "PER ASTE (category=asta, sourceType=tribunale): " +
    "pvp.giustizia.it (portale vendite pubbliche ufficiale), asteonline.it, astegiudiziarie.it, portaleaste.it, asteimmobili.it, siti dei singoli tribunali italiani. " +
    "Cerca procedure esecutive immobiliari attive con numero lotto e data asta.\n" +
    "PER LUXURY (category=luxury, sourceType=luxury-broker): " +
    "sothebysrealty.it, knightfrank.it, engelvoelkers.com/it, luxuryestate.com, gate-away.com, christiesrealestate.com, ville-casali.com. " +
    "Solo immobili di pregio non presenti sui portali standard.\n" +
    "PER OFF-MARKET (category=off-market, sourceType=off-market): " +
    "anbsc.it (beni confiscati alla mafia), agenziadelbeni.gov.it, vendite.comune.milano.it e portali comunali simili, " +
    "portafogli NPL bancari, annunci liquidazioni aziendali.\n" +
    "Rispetta SEMPRE i filtri region/city/type ricevuti. " +
    "Ogni property DEVE avere url HTTP reale e verificabile. Se non hai URL diretto NON includere. " +
    "Se non trovi nulla: {\"properties\":[]}. MAI inventare.",
  search_grants: "Sei un esperto di finanziamenti italiani con accesso al web. Cerca bandi REALI da: inps.it, invitalia.it, agenziaentrate.gov.it, mise.gov.it, regioni. Rispondi SOLO in JSON. Se non trovi nulla, ritorna {\"success\":true,\"results\":[]}. MAI inventare.",
  deep_search: "Sei un assistente di ricerca con accesso al web. Cerca notizie aggiornate da fonti affidabili. Rispondi SOLO in JSON. Se non trovi nulla, ritorna {\"success\":true,\"newsCards\":[]}.",
  distress_radar: "Sei un esperto di opportunità in Italia con accesso al web. Cerca aste giudiziarie su: tribunale.it, asteonline.it, astegiudiziarie.it, idealista.it/aste. Rispondi SOLO in JSON. Se non trovi nulla, ritorna {\"success\":true,\"signals\":[]}. MAI inventare.",
  market_glitch: "Sei un esperto di anomalie di prezzo con accesso al web. Cerca prodotti con prezzi insolitamente bassi su Amazon.it, eBay.it, Unieuro, MediaWorld. Rispondi SOLO in JSON. Se non trovi nulla, ritorna {\"success\":true,\"glitches\":[]}. MAI inventare.",
  deep_recovery: "Sei un esperto di crediti dormienti italiani con accesso al web. Ricerca su INPS, Agenzia Entrate, Bankitalia, IVASS. Rispondi SOLO in JSON. Se non trovi nulla, ritorna {\"success\":true,\"credits\":[]}. MAI inventare.",
  find_contacts: "Sei un assistente per contatti ufficiali italiani con accesso al web. Usa INI-PEC, siti istituzionali, Registro Imprese. Rispondi SOLO in JSON. Se non trovi nulla, ritorna {\"results\":[]}. MAI inventare.",
  find_company_contacts: "Sei un assistente per contatti aziendali italiani con accesso al web. Cerca su INI-PEC, Registro Imprese, sito ufficiale. Rispondi SOLO in JSON. Se non trovi nulla, ritorna {\"success\":true,\"contact\":null}. MAI inventare.",
  ai_bandi:
    "Sei un esperto di bandi italiani con accesso al web. " +
    "Analizza la query ricevuta e cerca informazioni aggiornate da: invitalia.it, mise.gov.it, inps.it, gazzettaufficiale.it, regioni italiane. " +
    "Rispondi SOLO in JSON con questa struttura: " +
    "{\"ok\":true,\"confidence_score\":75,\"data\":{" +
    "\"summary_3_lines\":[\"riga 1\",\"riga 2\",\"riga 3\"]," +
    "\"checklist_documents\":[\"doc 1\",\"doc 2\"]," +
    "\"questions_to_ask\":[\"domanda 1\"]," +
    "\"risks_and_attention\":[\"rischio 1\"]," +
    "\"next_steps\":[\"passo 1\"]," +
    "\"sources\":[{\"title\":\"fonte\",\"url\":\"https://url\"}]," +
    "\"confidence_notes\":\"\"}}. " +
    "Se le informazioni sono incomplete abbassa confidence_score e segnalalo in confidence_notes. " +
    "Se non trovi nulla ritorna {\"ok\":true,\"confidence_score\":0,\"data\":{\"summary_3_lines\":[\"Nessun dato trovato\"],\"checklist_documents\":[],\"questions_to_ask\":[],\"risks_and_attention\":[],\"next_steps\":[],\"sources\":[],\"confidence_notes\":\"Ricerca non disponibile al momento\"}}.",
};

async function callPerplexity(prompt: string, task: string, maxTokens: number): Promise<string | null> {
  const key = Deno.env.get("PERPLEXITY_API_KEY") ?? "";
  if (!key) { console.warn("[perplexity] PERPLEXITY_API_KEY not configured"); return null; }
  const system = PERPLEXITY_SYSTEM[task] ?? "Rispondi SOLO in JSON valido. MAI inventare dati.";
  const { signal, clear } = withAbort(30_000);
  const t = Date.now();
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        max_tokens: maxTokens,
        temperature: 0.0,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        return_citations: true,
        search_recency_filter: "month",
      }),
      signal,
    });
    if (!res.ok) { console.warn(`[perplexity] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const output: string = data?.choices?.[0]?.message?.content ?? "";
    console.log(`[perplexity] ok citations=${(data?.citations??[]).length} output_len=${output.length} latency=${Date.now()-t}ms`);
    return output.trim().length > 5 ? output : null;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") console.warn("[perplexity] Timeout");
    else console.warn("[perplexity] Failed:", String(e));
    return null;
  } finally { clear(); }
}

async function runAI(prompt: string, domain: string, task?: string): Promise<string> {
  const { maxTokens: baseTokens, temperature } = getPipeline(domain);
  const maxTokens = (task && TASK_TOKEN_OVERRIDES[task]) || baseTokens;
  console.log(`[ai] runAI domain=${domain} maxTokens=${maxTokens}`);
  try {
    return await callOpenAI(prompt, temperature, maxTokens);
  } catch (e1) {
    console.warn("[ai] OpenAI failed, trying Anthropic:", String(e1));
    try {
      return await callAnthropic(prompt, temperature, maxTokens);
    } catch (e2) {
      console.error("[ai] Both OpenAI and Anthropic failed:", String(e2));
      throw new Error(`All AI providers failed. OpenAI: ${String(e1).slice(0, 100)}. Anthropic: ${String(e2).slice(0, 100)}`);
    }
  }
}

async function runWebAI(prompt: string, domain: string, task: string): Promise<string> {
  const maxTokens = TASK_TOKEN_OVERRIDES[task] || getPipeline(domain).maxTokens;
  console.log(`[ai] runWebAI domain=${domain} task=${task}`);
  const output = await callPerplexity(prompt, task, maxTokens);
  if (output) { console.log(`[ai] Perplexity ok task=${task} len=${output.length}`); return output; }
  const empty = EMPTY_RESULTS[task] ?? `{"ok":false,"error":"Ricerca non disponibile"}`;
  console.warn(`[ai] Perplexity unavailable for task=${task} — returning empty`);
  return empty;
}

function parseOutput(raw: string): unknown | null {
  if (!raw || raw.trim().length < 2) return null;
  const s = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(s); } catch (e) { console.debug("[parseOutput] direct parse failed:", String(e).slice(0, 80)); }
  const fb = s.indexOf("{"), lb = s.lastIndexOf("}");
  if (fb !== -1 && lb > fb) { try { return JSON.parse(s.slice(fb, lb + 1)); } catch (e) { console.debug("[parseOutput] braces parse failed:", String(e).slice(0, 80)); } }
  const fab = s.indexOf("["), lab = s.lastIndexOf("]");
  if (fab !== -1 && lab > fab) { try { return JSON.parse(s.slice(fab, lab + 1)); } catch (e) { console.debug("[parseOutput] brackets parse failed:", String(e).slice(0, 80)); } }
  return null;
}

function filterValidProperties(raw: unknown): unknown[] {
  if (!raw || typeof raw !== "object") return [];
  const data = raw as Record<string, unknown>;
  const props = Array.isArray(data.properties) ? data.properties : [];
  return props.filter((p: any) => {
    if (!p || typeof p !== "object") return false;
    // Scarta annunci senza URL — non verificabili
    if (!p.url || typeof p.url !== "string" || !p.url.startsWith("http")) return false;
    // Scarta annunci con prezzo 0 o negativo
    if (typeof p.price === "number" && p.price < 0) return false;
    // Scarta annunci senza titolo
    if (!p.title || typeof p.title !== "string" || p.title.trim().length < 5) return false;
    return true;
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });

  const debugId = makeDebugId();
  const pathname = new URL(req.url).pathname;

  try {
    if (req.method === "GET" && (pathname.endsWith("/health") || pathname.endsWith("/__health") || pathname === "/")) {
      return okResponse(req, {
        status: "ok", version: "3.1.0", time: new Date().toISOString(),
      }, debugId);
    }

    const authErr = checkAuth(req, debugId);
    if (authErr) return authErr;
    if (req.method !== "POST") return errResponse(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId);

    const rawBody = await req.text();
    if (rawBody.length > 100_000) {
      return errResponse(req, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds 100KB limit", debugId);
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawBody); } catch {
      return errResponse(req, 400, "INVALID_JSON", "Body must be valid JSON", debugId);
    }

    if (pathname.endsWith("/tariffs/compare")) {
      const prompt = (body.prompt as string) || (body.text as string) || "";
      if (!prompt) return errResponse(req, 400, "MISSING_PROMPT", "Provide prompt field", debugId);
      if (prompt.length > 15_000) return errResponse(req, 400, "PROMPT_TOO_LONG", "Prompt exceeds 15000 characters", debugId);
      console.log(`[ai-core-run] tariffs/compare debug_id=${debugId}`);
      const output = await runAI(prompt, "wyloni_bandi");
      const parsed = parseOutput(output) as Record<string, unknown> | null;
      return okResponse(req, { final_output: output, data: parsed, offers: parsed?.offers ?? [], debug_id: debugId }, debugId);
    }

    if (pathname.endsWith("/documents/analyze")) {
      const text = (body.text as string) ?? (body.pdf_text as string) ?? (body.prompt as string) ?? "";
      if (!text || text.trim().length < 20) {
        return okResponse(req, { status: "NOT_READABLE", extracted: {}, quality: { gate: "NOT_READABLE", score: 0, notes: ["No text"] } }, debugId);
      }
      const extractPrompt = `Estrai i dati dalla bolletta italiana e rispondi SOLO in JSON:\n{"periodo":{"from":"DD/MM/YYYY","to":"DD/MM/YYYY"},"fornitore":{"label":"nome fornitore"},"consumi":{"totale_kwh":null,"unit":"kWh"},"importi":{"totale_da_pagare_eur":null,"bonus_sociale":{"presente":false,"eur":null}}}\n\nBolletta:\n${text.slice(0, 8000)}`;
      let extracted: unknown = {};
      try { const out = await runAI(extractPrompt, "wyloni_bandi"); extracted = parseOutput(out) ?? {}; } catch (e) { console.warn("[documents/analyze] extraction failed:", String(e).slice(0, 150)); }
      return okResponse(req, { status: "READY", extracted, quality: { gate: "READY", score: 80, notes: ["AI extraction"] } }, debugId);
    }

    const domain = (body.domain as string) || "wyloni_bandi";
    const task   = (body.task   as string) || "";
    const prompt = (body.prompt as string) || (body.text as string) || "";

    if (!prompt) return errResponse(req, 400, "MISSING_PROMPT", "Provide prompt field", debugId);
    if (prompt.length > 15_000) return errResponse(req, 400, "PROMPT_TOO_LONG", `Prompt exceeds 15000 characters`, debugId);

    const sourceApp = req.headers.get("x-source-app") ?? "unknown";
    console.log(`[ai-core-run] domain=${domain} task=${task} prompt_len=${prompt.length} source_app=${sourceApp} debug_id=${debugId}`);

    const output = WEB_TASKS.has(task)
      ? await runWebAI(prompt, domain, task)
      : await runAI(prompt, domain, task);

    const parsed = parseOutput(output);

    // Per immobili: filtra solo annunci con URL reale
    if (task === "real_estate_deep" && parsed && typeof parsed === "object") {
      const validProps = filterValidProperties(parsed);
      const cleanData = { ...(parsed as Record<string, unknown>), properties: validProps };
      console.log(`[ai-core-run] real_estate valid_properties=${validProps.length}`);
      return okResponse(req, {
        final_output: output,
        data: cleanData,
        properties: validProps,
        debug_id: debugId,
      }, debugId);
    }

    const raw = parsed as Record<string, unknown> | null;
    console.log(`[ai-core-run] output_len=${output.length}`);

    return okResponse(req, {
      final_output: output,
      data: parsed,
      offers:     raw?.offers     ?? [],
      properties: raw?.properties ?? [],
      results:    raw?.results    ?? [],
      debug_id: debugId,
    }, debugId);

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[ai-core-run] Error debug_id=${debugId}:`, errMsg);
    return errResponse(req, 500, "INTERNAL_ERROR", "An internal error occurred. Reference: " + debugId, debugId);
  }
});
