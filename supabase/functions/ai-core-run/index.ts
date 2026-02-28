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

/** Web search con dati REALI. Per immobili usa Perplexity direttamente (ha web search nativo). MAI OpenAI per sintetizzare dati che devono essere reali. */
async function runWebSearch(
  prompt: string,
  domain: string,
  task: string,
): Promise<string> {
  const pipeline = getPipeline(domain);
  const maxTokens = pipeline.MAX_TOKENS;
  console.log(`[ai-core-run] webSearch domain=${domain} task=${task}`);

  // Per real_estate_deep: usa Perplexity DIRETTAMENTE come LLM con web search
  // Non passare mai per OpenAI — allucinano sempre
  if (task === "real_estate_deep") {
    const key = Deno.env.get("PERPLEXITY_API_KEY");
    if (!key) {
      console.warn("[ai-core-run] PERPLEXITY_API_KEY mancante — ritorno vuoto");
      return `{"properties":[]}`;
    }

    const filters = prompt.slice(0, 500);
    const perplexityPrompt = `Cerca annunci immobiliari REALI su Idealista, Immobiliare.it, Casa.it, Subito.it basandoti su questi filtri: ${filters}

Rispondi SOLO con un JSON valido, senza testo prima o dopo. Usa SOLO annunci che hai trovato realmente sul web. Se non trovi nulla, ritorna {"properties":[]}.

Formato richiesto:
{"properties":[{"id":"1","title":"titolo annuncio reale","type":"vendita","category":"standard","price":180000,"pricePerSqm":2250,"location":{"city":"Milano","province":"MI","region":"Lombardia","zone":""},"details":{"sqm":80,"rooms":3,"bathrooms":1,"floor":"2"},"features":["Balcone"],"source":"Idealista","sourceType":"agenzia-locale","url":"https://url-annuncio-reale","discoveredAt":"2026-02-28","discount":0,"notes":""}]}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const started = Date.now();

    try {
      const res = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "sonar",
          max_tokens: maxTokens,
          temperature: 0.0,
          messages: [
            {
              role: "system",
              content: "Sei un assistente che cerca annunci immobiliari reali sul web. Rispondi SEMPRE e SOLO in JSON valido. Se non trovi annunci reali, ritorna {\"properties\":[]}. MAI inventare annunci.",
            },
            { role: "user", content: perplexityPrompt },
          ],
          return_citations: true,
          search_recency_filter: "month",
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        console.warn(`[ai-core-run] Perplexity error ${res.status}`);
        return `{"properties":[]}`;
      }

      const data = await res.json();
      const output: string = data?.choices?.[0]?.message?.content ?? "";
      console.log(`[ai-core-run] Perplexity real_estate output_len=${output.length} latency=${Date.now()-started}ms`);

      if (!output || output.trim().length < 10) return `{"properties":[]}`;
      return output;
    } catch (err) {
      clearTimeout(timer);
      console.warn("[ai-core-run] Perplexity real_estate failed:", String(err));
      return `{"properties":[]}`;
    }
  }

  // Per search_grants, find_contacts, ai_bandi: Perplexity search + OpenAI synthesis
  const searchResult = await perplexitySearch(prompt.slice(0, 400));
  if (!searchResult || searchResult.answer.trim().length < 30) {
    console.warn("[ai-core-run] Perplexity returned no data — returning empty");
    if (task === "search_grants")  return `{"success":true,"results":[]}`;
    if (task === "find_contacts")  return `{"results":[]}`;
    if (task === "ai_bandi")       return `{"ok":true,"data":{"results":[]}}`;
    return `{"ok":false,"error":"Nessun dato trovato"}`;
  }

  console.log(`[ai-core-run] Perplexity ok citations=${searchResult.citations.length}`);

  let scrapedContent = "";
  if (searchResult.citations.length > 0) {
    const scraped = await firecrawlBatch(searchResult.citations.slice(0, 2).map(c => c.url));
    if (scraped.length > 0) {
      console.log(`[ai-core-run] Firecrawl scraped ${scraped.length} pages`);
      scrapedContent = scraped.map(s => `### ${s.title}\n${s.markdown}`).join("\n\n");
    }
  }

  const webContext = [searchResult.answer, scrapedContent].filter(Boolean).join("\n\n").slice(0, 4000);

  let synthesisPrompt: string;

  if (task === "search_grants") {
    synthesisPrompt = `Usando SOLO i dati reali qui sotto, elenca i bandi trovati. Se non ci sono dati sufficienti, usa results:[].

DATI WEB:\n${webContext}

Rispondi SOLO in JSON: {"success":true,"results":[{"title":"","description":"","url":"","source":"","isPdf":false}]}`;
  } else if (task === "find_contacts") {
    synthesisPrompt = `Usando SOLO i dati reali qui sotto, estrai i contatti. Se non ci sono, usa results:[].

DATI WEB:\n${webContext}

Rispondi SOLO in JSON: {"results":[{"id":"1","name":"","pec":"","email":"","phone":"","address":"","website":"","source":"","source_url":""}]}`;
  } else {
    synthesisPrompt = `${prompt}\n\nDATI REALI (usa SOLO questi):\n${webContext}`;
  }

  const oaiKey = Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPENAI_KEY") ?? "";
  if (!oaiKey) throw new Error("OPENAI_API_KEY not configured");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${oaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: synthesisPrompt }],
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
    const d = await res.json();
    const out = d?.choices?.[0]?.message?.content ?? "";
    console.log(`[ai-core-run] synthesis ok output_len=${out.length}`);
    return out;
  } finally {
    clearTimeout(t);
  }
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
