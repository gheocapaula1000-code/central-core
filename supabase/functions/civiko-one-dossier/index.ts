// Civiko One Rebuild — Owner Dossier generator.
// Generates a structured owner-facing dossier for a property case, in Italian.
// The prompt and zone-scoring logic stay server-side (thin-frontend / anti-copy).
//
// POST /civiko-one-dossier  { agency_id, case_id }
// Returns: { ok, data: { output_id, version, content } }

import { authorizeCivikoOne, civikoOneCors, errorResponse, jsonResponse } from "../_shared/civikoOneAuth.ts";

const LOVABLE_AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash";

// Prompt proprietario — NON deve mai essere esposto al client.
const DOSSIER_SYSTEM_PROMPT = `Sei "Assistente Civiko", redattore esperto di dossier immobiliari proprietari per agenzie italiane.
Produci un dossier sobrio, professionale e premium, in italiano, mai sensazionalistico.
Vincoli:
- Mai inventare dati. Se un campo manca, scrivi "dato non disponibile".
- Non usare le parole "AI", "intelligenza artificiale", "GPT", "ChatGPT".
- Tono: assertivo, fattuale, orientato al valore. Mobile-first leggibile.
- Struttura JSON richiesta in output, niente markdown extra fuori dai campi.

Output JSON con questi campi:
{
  "headline": string (max 90 char),
  "executive_summary": string (max 600 char),
  "punti_forza": string[] (3-5 bullet),
  "punti_attenzione": string[] (2-4 bullet),
  "posizionamento_prezzo": string (max 400 char, prudente),
  "azioni_consigliate": string[] (3-5 bullet, operative per l'agente),
  "note_finali": string (max 300 char)
}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: civikoOneCors });
  if (req.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", "Use POST", 405);

  try {
    const body = await req.json().catch(() => ({}));
    const { agency_id, case_id } = body as { agency_id?: string; case_id?: string };

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
    if (!caseRow) return errorResponse("CASE_NOT_FOUND", "Case not found in this agency", 404);

    const apiKey = Deno.env.get("LOVABLE_API_KEY") ?? "";
    if (!apiKey) return errorResponse("AI_KEY_MISSING", "LOVABLE_API_KEY not configured", 500);

    const userPayload = {
      titolo: caseRow.title,
      tipologia: caseRow.property_type,
      indirizzo: caseRow.address_text,
      comune: caseRow.municipality,
      cap: caseRow.cap,
      provincia: caseRow.province,
      microzona: caseRow.microzone,
      mq: caseRow.surface_mq,
      locali: caseRow.rooms,
      bagni: caseRow.bathrooms,
      piano: caseRow.floor,
      classe_energetica: caseRow.energy_class,
      anno_costruzione: caseRow.year_built,
      prezzo_richiesto_eur: caseRow.ask_price,
      note_agente: caseRow.notes,
    };

    const aiResp = await fetch(LOVABLE_AI_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: DOSSIER_SYSTEM_PROMPT },
          { role: "user", content: `Dati immobile:\n${JSON.stringify(userPayload, null, 2)}\n\nGenera il dossier JSON.` },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (aiResp.status === 429) return errorResponse("AI_RATE_LIMITED", "Rate limit raggiunto, riprova tra poco", 429);
    if (aiResp.status === 402) return errorResponse("AI_PAYMENT_REQUIRED", "Credito AI esaurito", 402);
    if (!aiResp.ok) {
      const txt = await aiResp.text();
      return errorResponse("AI_UPSTREAM_ERROR", `AI ${aiResp.status}: ${txt.slice(0, 200)}`, 502);
    }

    const aiJson = await aiResp.json();
    const raw = aiJson?.choices?.[0]?.message?.content ?? "{}";
    let content: Record<string, unknown> = {};
    try {
      content = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      content = { raw };
    }

    // Versione = max(version) + 1 per (case_id, kind)
    const { data: prev } = await serviceClient
      .from("civiko_one_generated_outputs")
      .select("version")
      .eq("case_id", case_id)
      .eq("kind", "owner_dossier")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextVersion = (prev?.version ?? 0) + 1;

    const { data: saved, error: saveErr } = await serviceClient
      .from("civiko_one_generated_outputs")
      .insert({
        case_id,
        agency_id: agencyId,
        generated_by: userId,
        kind: "owner_dossier",
        version: nextVersion,
        content_jsonb: content,
        model_used: MODEL,
      })
      .select("id, version, created_at")
      .single();

    if (saveErr || !saved) return errorResponse("SAVE_FAILED", saveErr?.message ?? "save failed", 500);

    return jsonResponse({
      ok: true,
      data: {
        output_id: saved.id,
        version: saved.version,
        created_at: saved.created_at,
        content,
      },
    });
  } catch (e) {
    return errorResponse("INTERNAL_ERROR", e instanceof Error ? e.message : String(e), 500);
  }
});
