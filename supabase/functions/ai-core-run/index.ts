import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  makeDebugId, corsHeaders, handleOptions,
  ok, fail, requireSecret,
} from "../_shared/http.ts";
import { callOpenAI } from "./providers/openai.ts";
import { callAnthropic } from "./providers/anthropic.ts";
import * as PipelineWyloni from "./pipelines/wyloni_bandi.ts";
import * as PipelinePratica from "./pipelines/pratica_legal.ts";
import * as PipelineKeydraft from "./pipelines/keydraft_realestate.ts";

function getPipeline(domain: string) {
  if (domain === "pratica_legal") return PipelinePratica;
  if (domain === "keydraft_realestate") return PipelineKeydraft;
  return PipelineWyloni;
}

async function runAI(prompt: string, domain: string): Promise<string> {
  const pipeline = getPipeline(domain);
  const maxTokens = pipeline.MAX_TOKENS;
  const temp = pipeline.TEMPERATURE;

  try {
    const { output } = await callOpenAI(prompt, temp, maxTokens);
    return output;
  } catch (errA) {
    console.warn("[ai-core-run] OpenAI failed:", String(errA), "— trying Anthropic");
    try {
      const { output } = await callAnthropic(prompt, temp, maxTokens);
      return output;
    } catch (errB) {
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

    // ── 404 ───────────────────────────────────────────────────────────────
    return fail(req, 404, "NOT_FOUND", `Path not found: ${pathname}`, debugId);

  } catch (err) {
    console.error("[ai-core-run] Unhandled error:", String(err));
    return fail(req, 500, "INTERNAL_ERROR", String(err).slice(0, 200), debugId);
  }
});
