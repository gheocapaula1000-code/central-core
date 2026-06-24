// Civiko One Rebuild — Piano promo leggero V1.
// Produce un piano promozionale base in 7-14 giorni per il case.
//
// POST /civiko-one-promo { agency_id, case_id, days?: 7|14 (default 14) }

import { authorizeCivikoOne, civikoOneCors, errorResponse, jsonResponse } from "../_shared/civikoOneAuth.ts";

const LOVABLE_AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash";

const PROMO_SYSTEM_PROMPT = `Sei "Assistente Promo Civiko", pianifichi attività promozionali leggere per agenzie immobiliari italiane.
Vincoli:
- Mai inventare strumenti che l'agenzia non ha. Resta su: portali immobiliari, social organico (Instagram/Facebook), email lista propria, cartellonistica vetrina, open house.
- Mai usare "AI", "intelligenza artificiale", "GPT".
- Sii concreto, operativo, niente fuffa marketing.

Output JSON:
{
  "obiettivo": string (max 200 char),
  "kpi_attesi": string[] (2-4 bullet),
  "giorni": [
    { "giorno": number, "azione": string, "canale": string, "owner": "agente"|"agenzia", "note": string }
  ],
  "checklist_partenza": string[]
}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: civikoOneCors });
  if (req.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", "Use POST", 405);

  try {
    const body = await req.json().catch(() => ({}));
    const { agency_id, case_id } = body as { agency_id?: string; case_id?: string };
    const days = body?.days === 7 ? 7 : 14;

    if (!case_id) return errorResponse("CASE_ID_REQUIRED", "case_id missing");
    const auth = await authorizeCivikoOne(req, agency_id);
    if (!auth.ok) return errorResponse(auth.code, auth.message, auth.status);
    const { serviceClient, agencyId, userId } = auth;

    const { data: caseRow, error: caseErr } = await serviceClient
      .from("civiko_one_property_cases")
      .select("*")
      .eq("id", case_id)
      .eq("agency_id", agencyId)
      .maybeSingle();
    if (caseErr) return errorResponse("CASE_LOOKUP_FAILED", caseErr.message, 500);
    if (!caseRow) return errorResponse("CASE_NOT_FOUND", "Case not found", 404);

    const apiKey = Deno.env.get("LOVABLE_API_KEY") ?? "";
    if (!apiKey) return errorResponse("AI_KEY_MISSING", "LOVABLE_API_KEY not configured", 500);

    const facts = {
      titolo: caseRow.title,
      tipologia: caseRow.property_type,
      comune: caseRow.municipality,
      microzona: caseRow.microzone,
      mq: caseRow.surface_mq,
      locali: caseRow.rooms,
      prezzo: caseRow.ask_price,
      durata_giorni: days,
    };

    const aiResp = await fetch(LOVABLE_AI_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: PROMO_SYSTEM_PROMPT },
          { role: "user", content: `Pianifica ${days} giorni per:\n${JSON.stringify(facts, null, 2)}` },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (aiResp.status === 429) return errorResponse("AI_RATE_LIMITED", "Rate limit", 429);
    if (aiResp.status === 402) return errorResponse("AI_PAYMENT_REQUIRED", "Credito esaurito", 402);
    if (!aiResp.ok) {
      const txt = await aiResp.text();
      return errorResponse("AI_UPSTREAM_ERROR", `AI ${aiResp.status}: ${txt.slice(0, 200)}`, 502);
    }

    const aiJson = await aiResp.json();
    const raw = aiJson?.choices?.[0]?.message?.content ?? "{}";
    let content: Record<string, unknown> = {};
    try { content = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { content = { raw }; }

    const { data: prev } = await serviceClient
      .from("civiko_one_generated_outputs")
      .select("version")
      .eq("case_id", case_id)
      .eq("kind", "promo_plan")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextVersion = (prev?.version ?? 0) + 1;

    const { data: saved, error: saveErr } = await serviceClient
      .from("civiko_one_generated_outputs")
      .insert({
        case_id, agency_id: agencyId, generated_by: userId,
        kind: "promo_plan", version: nextVersion, content_jsonb: content, model_used: MODEL,
      })
      .select("id, version, created_at")
      .single();

    if (saveErr || !saved) return errorResponse("SAVE_FAILED", saveErr?.message ?? "save failed", 500);

    return jsonResponse({
      ok: true,
      data: { output_id: saved.id, version: saved.version, created_at: saved.created_at, content },
    });
  } catch (e) {
    return errorResponse("INTERNAL_ERROR", e instanceof Error ? e.message : String(e), 500);
  }
});
