import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  makeDebugId, corsHeaders, handleOptions,
  ok, fail, requireSecret,
} from "../_shared/http.ts";
import { callOpenAI } from "./providers/openai.ts";
import { callAnthropic } from "./providers/anthropic.ts";
import { perplexitySearch } from "./providers/perplexity.ts";
import { firecrawlBatch } from "./providers/firecrawl.ts";
import * as PipelineWyloni from "./pipelines/wyloni_bandi.ts";
import * as PipelinePratica from "./pipelines/pratica_legal.ts";
import * as PipelineKeydraft from "./pipelines/keydraft_realestate.ts";

function getPipeline(domain: string) {
  if (domain === "pratica_legal") return PipelinePratica;
  if (domain === "keydraft_realestate") return PipelineKeydraft;
  return PipelineWyloni;
}

/** Web-enhanced AI: search with Perplexity, optionally scrape with Firecrawl, then synthesize with OpenAI */
async function runWebSearch(
  prompt: string,
  domain: string,
  task: string,
): Promise<string> {
  const pipeline = getPipeline(domain);
  const maxTokens = pipeline.MAX_TOKENS;
  console.log(`[ai-core-run] webSearch domain=${domain} task=${task}`);

  // Step 1: Search with Perplexity
  const searchResult = await perplexitySearch(prompt.slice(0, 300));
  let context = "";

  if (searchResult) {
    console.log(`[ai-core-run] Perplexity ok citations=${searchResult.citations.length}`);
    context = searchResult.answer.slice(0, 1500);

    // Step 2: Optionally scrape top URL with Firecrawl for richer data
    if (searchResult.citations.length > 0) {
      const topUrls = searchResult.citations.slice(0, 2).map(c => c.url);
      const scraped = await firecrawlBatch(topUrls);
      if (scraped.length > 0) {
        console.log(`[ai-core-run] Firecrawl scraped ${scraped.length} pages`);
        context += "\n\nCONTENUTO PAGINE:\n" + scraped.map(s => `${s.title}:\n${s.markdown}`).join("\n\n").slice(0, 2000);
      }
    }
  } else {
    console.warn("[ai-core-run] Perplexity unavailable — falling back to pure OpenAI");
  }

  // Step 3: Build synthesis prompt based on task
  let synthesisPrompt: string;

  if (task === "real_estate_deep") {
    synthesisPrompt = context
      ? `Sei un esperto immobiliare italiano. Dai dati reali trovati sul web, estrai e formatta 3-5 annunci immobiliari in JSON.

DATI WEB:
${context.slice(0, 3000)}

Rispondi SOLO con questo JSON (compila tutti i campi con dati reali dal contesto):
{"properties":[{"id":"prop-1","title":"titolo annuncio","type":"vendita","category":"standard","price":0,"pricePerSqm":0,"location":{"city":"","province":"","region":"","zone":""},"details":{"sqm":0,"rooms":0,"bathrooms":0,"floor":""},"features":[],"source":"","sourceType":"agenzia-locale","url":"","discoveredAt":"2026-02-28","discount":0,"notes":""}]}`
      : `Sei un esperto immobiliare italiano. Genera 3-5 annunci immobiliari REALISTICI basati sui filtri forniti. Rispondi SOLO in JSON:
{"properties":[{"id":"prop-1","title":"Appartamento 3 locali","type":"vendita","category":"standard","price":180000,"pricePerSqm":2250,"location":{"city":"Milano","province":"MI","region":"Lombardia","zone":"Navigli"},"details":{"sqm":80,"rooms":3,"bathrooms":1,"floor":"2° piano"},"features":["Balcone","Riscaldamento autonomo"],"source":"Idealista","sourceType":"agenzia-locale","url":"https://www.idealista.it","discoveredAt":"2026-02-28","discount":0,"notes":""}]}`;
  } else if (task === "search_grants") {
    synthesisPrompt = context
      ? `Sei un esperto di finanziamenti italiani. Dai dati reali trovati sul web, elenca 4-6 bandi o agevolazioni disponibili.

DATI WEB:
${context.slice(0, 3000)}

Rispondi SOLO con questo JSON:
{"success":true,"results":[{"title":"nome bando","description":"descrizione dettagliata con importo e requisiti","url":"https://url-ufficiale","source":"INPS / Agenzia Entrate / ecc.","isPdf":false}]}`
      : prompt;
  } else if (task === "find_contacts") {
    synthesisPrompt = context
      ? `Dai dati trovati sul web, estrai i contatti richiesti.

DATI WEB:
${context.slice(0, 3000)}

Rispondi SOLO con questo JSON:
{"results":[{"id":"1","name":"","pec":"","email":"","phone":"","address":"","website":"","source":"","source_url":""}]}`
      : prompt;
  } else {
    synthesisPrompt = context
      ? `${prompt}\n\nDATI AGGIORNATI DA RICERCA WEB:\n${context}`
      : prompt;
  }

  return await runAI(synthesisPrompt, domain);
}

async function runAI(prompt: string, domain: string): Promise<string> {
  const pipeline = getPipeline(domain);
  const maxTokens = pipeline.MAX_TOKENS;
  const temp = pipeline.TEMPERATURE;

  const keyOAI = Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPENAI_KEY") ?? "";
  const keyANT = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

  console.log(`[ai-core-run] runAI domain=${domain} maxTokens=${maxTokens} hasOAI=${!!keyOAI} hasANT=${!!keyANT}`);

  try {
    const { output, latencyMs } = await callOpenAI(prompt, temp, maxTokens);
    console.log(`[ai-core-run] OpenAI ok latency=${latencyMs}ms output_len=${output.length}`);
    return output;
  } catch (errA) {
    console.error("[ai-core-run] OpenAI failed:", String(errA));
    try {
      const { output, latencyMs } = await callAnthropic(prompt, temp, maxTokens);
      console.log(`[ai-core-run] Anthropic ok latency=${latencyMs}ms output_len=${output.length}`);
      return output;
    } catch (errB) {
      console.error("[ai-core-run] Anthropic failed:", String(errB));
      throw new Error(`Both models failed. OpenAI: ${String(errA)} | Anthropic: ${String(errB)}`);
    }
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const url = new URL(req.url);
  const pathname = url.pathname;

  try {
    // ── GET /health ───────────────────────────────────────────────────────
    if (req.method === "GET" && (
      pathname.endsWith("/health") ||
      pathname.endsWith("/__health")
    )) {
      return ok(req, {
        status: "ok",
        time: new Date().toISOString(),
        version: Deno.env.get("CORE_VERSION") ?? "1.0.0",
      }, [], debugId);
    }

    // ── POST /ai/run ──────────────────────────────────────────────────────
    if (req.method === "POST" && pathname.endsWith("/ai/run")) {
      const authErr = requireSecret(req, debugId);
      if (authErr) return authErr;

      let body: Record<string, unknown>;
      try { body = await req.json(); }
      catch { return fail(req, 400, "INVALID_JSON", "Invalid JSON body", debugId); }

      const domain = (body.domain as string) || "wyloni_bandi";
      const prompt = (body.prompt as string) || (body.text as string) || "";
      if (!prompt) return fail(req, 400, "MISSING_PROMPT", "Provide prompt or text field", debugId);

      console.log(`[ai-core-run] domain=${domain} prompt_len=${prompt.length} debug_id=${debugId}`);

      const output = await runAI(prompt, domain);

      let parsed: unknown = null;
      try {
        const clean = output.replace(/```json|```/g, "").trim();
        parsed = JSON.parse(clean);
      } catch { /* not JSON, return as text */ }

      return ok(req, {
        final_output: output,
        data: parsed,
        domain,
        debug_id: debugId,
      }, [], debugId);
    }

    // ── POST /tariffs/compare ─────────────────────────────────────────────
    if (req.method === "POST" && pathname.endsWith("/tariffs/compare")) {
      const authErr = requireSecret(req, debugId);
      if (authErr) return authErr;

      let body: Record<string, unknown>;
      try { body = await req.json(); }
      catch { return fail(req, 400, "INVALID_JSON", "Invalid JSON body", debugId); }

      const prompt = (body.prompt as string) || (body.text as string) || "";
      if (!prompt) return fail(req, 400, "MISSING_PROMPT", "Provide prompt or text field", debugId);

      console.log(`[ai-core-run] tariffs/compare prompt_len=${prompt.length} debug_id=${debugId}`);

      const output = await runAI(prompt, "wyloni_bandi");

      let parsed: unknown = null;
      try {
        const clean = output.replace(/```json|```/g, "").trim();
        parsed = JSON.parse(clean);
      } catch { /* not JSON */ }

      return ok(req, {
        final_output: output,
        data: parsed,
        offers: (parsed as Record<string, unknown>)?.offers ?? [],
        debug_id: debugId,
      }, [], debugId);
    }

    // ── POST /documents/analyze ───────────────────────────────────────────
    if (req.method === "POST" && pathname.endsWith("/documents/analyze")) {
      const authErr = requireSecret(req, debugId);
      if (authErr) return authErr;

      let body: Record<string, unknown>;
      try { body = await req.json(); }
      catch { return fail(req, 400, "INVALID_JSON", "Invalid JSON body", debugId); }

      const text = (body.text as string) || (body.pdf_text as string) || (body.prompt as string) || "";
      if (!text || text.trim().length < 20) {
        return ok(req, {
          status: "NOT_READABLE",
          extracted: {},
          quality: { gate: "NOT_READABLE", score: 0, notes: ["No text provided"] },
        }, [], debugId);
      }

      const extractPrompt = `Estrai i dati dalla seguente bolletta italiana e rispondi SOLO in JSON con questi campi:
{"periodo":{"from":"DD/MM/YYYY","to":"DD/MM/YYYY"},"fornitore":{"label":"nome fornitore"},"consumi":{"totale_kwh":null,"unit":"kWh"},"importi":{"totale_da_pagare_eur":null,"bonus_sociale":{"presente":false,"eur":null}}}

Bolletta:
${text.slice(0, 8000)}`;

      let extracted: unknown = {};
      try {
        const output = await runAI(extractPrompt, "wyloni_bandi");
        const clean = output.replace(/```json|```/g, "").trim();
        extracted = JSON.parse(clean);
      } catch { /* return empty */ }

      return ok(req, {
        status: "READY",
        extracted,
        quality: { gate: "READY", score: 80, notes: ["AI extraction"] },
      }, [], debugId);
    }

    // ── Fallback: route by task in body (handles /ai-core-run base path) ──
    if (req.method === "POST") {
      let fallbackBody: Record<string, unknown> = {};
      try { fallbackBody = await req.json(); } catch { /* ignore */ }
      const task = (fallbackBody.task as string) || "";
      const prompt = (fallbackBody.prompt as string) || (fallbackBody.text as string) || "";
      const domain = (fallbackBody.domain as string) || "wyloni_bandi";

      if (prompt) {
        console.log(`[ai-core-run] fallback route task=${task} domain=${domain} debug_id=${debugId}`);
        // Tasks che beneficiano di web search reale
        const WEB_TASKS = ["search_grants", "find_contacts", "real_estate_deep", "ai_bandi", "find_company_contacts"];
        const useWeb = WEB_TASKS.includes(task);
        const output = useWeb ? await runWebSearch(prompt, domain, task) : await runAI(prompt, domain);
        console.log(`[ai-core-run] raw output preview: ${output.slice(0, 300)}`);
        let parsed: unknown = null;
        try {
          const cleaned = output
            .replace(/```json\s*/gi, "")
            .replace(/```\s*/g, "")
            .trim();
          // Find first { and last } to extract JSON even if there's surrounding text
          const firstBrace = cleaned.indexOf("{");
          const lastBrace = cleaned.lastIndexOf("}");
          const jsonStr = firstBrace !== -1 && lastBrace !== -1
            ? cleaned.slice(firstBrace, lastBrace + 1)
            : cleaned;
          parsed = JSON.parse(jsonStr);
          console.log(`[ai-core-run] parsed ok offers=${Array.isArray((parsed as any)?.offers) ? (parsed as any).offers.length : "not array"}`);
        } catch (e) {
          console.warn(`[ai-core-run] parse failed: ${String(e)}`);
        }
        return ok(req, {
          final_output: output,
          data: parsed,
          offers: (parsed as Record<string, unknown>)?.offers ?? [],
          debug_id: debugId,
        }, [], debugId);
      }
    }

    return fail(req, 404, "NOT_FOUND", `Path not found: ${pathname}`, debugId);

  } catch (err) {
    console.error("[ai-core-run] Unhandled error:", String(err));
    return fail(req, 500, "INTERNAL_ERROR", String(err).slice(0, 200), debugId);
  }
});
