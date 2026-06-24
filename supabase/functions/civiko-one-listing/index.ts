// Civiko One Rebuild — Multi-portal Listing generator.
// Produce testi annuncio ottimizzati per Casa.it, Immobiliare.it, Idealista, Subito.
// Prompt e regole portale restano server-side.
//
// POST /civiko-one-listing { agency_id, case_id, portals?: string[] }
// Default portals = tutti e 4.

import { authorizeCivikoOne, civikoOneCors, errorResponse, jsonResponse } from "../_shared/civikoOneAuth.ts";

const LOVABLE_AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash";

type Portal = "casa" | "immobiliare" | "idealista" | "subito";
const KIND_MAP: Record<Portal, "listing_casa" | "listing_immobiliare" | "listing_idealista" | "listing_subito"> = {
  casa: "listing_casa",
  immobiliare: "listing_immobiliare",
  idealista: "listing_idealista",
  subito: "listing_subito",
};

const PORTAL_RULES: Record<Portal, { titolo_max: number; descrizione_max: number; tono: string }> = {
  casa:        { titolo_max: 80,  descrizione_max: 1500, tono: "Professionale, descrittivo, ricco di dettagli tecnici." },
  immobiliare: { titolo_max: 80,  descrizione_max: 2000, tono: "Premium, narrativo ma fattuale, evidenzia posizione e finiture." },
  idealista:   { titolo_max: 70,  descrizione_max: 1200, tono: "Sintetico, mobile-first, bullet-friendly." },
  subito:      { titolo_max: 50,  descrizione_max: 800,  tono: "Diretto, concreto, niente fronzoli, telefono-friendly." },
};

const LISTING_SYSTEM_PROMPT = `Sei "Scanner Annunci Civiko", redattore di annunci immobiliari italiani per agenzie.
Vincoli inderogabili:
- Non inventare mai dati. Se mancano, ometti il dettaglio.
- Mai usare "AI", "intelligenza artificiale", "GPT".
- Mai promesse irrealistiche o claim non verificabili.
- Rispetta il limite caratteri di TITOLO e DESCRIZIONE indicato.
- Inserisci sempre disclaimer breve sulla conformità urbanistica solo se nei dati c'è un'incertezza.
Output JSON: { "titolo": string, "descrizione": string, "tag_principali": string[] }`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: civikoOneCors });
  if (req.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", "Use POST", 405);

  try {
    const body = await req.json().catch(() => ({}));
    const { agency_id, case_id } = body as { agency_id?: string; case_id?: string };
    const requestedPortals: Portal[] = Array.isArray(body?.portals) && body.portals.length > 0
      ? body.portals.filter((p: string): p is Portal => p in KIND_MAP)
      : ["casa", "immobiliare", "idealista", "subito"];

    if (!case_id) return errorResponse("CASE_ID_REQUIRED", "case_id missing");
    if (requestedPortals.length === 0) return errorResponse("PORTALS_INVALID", "No valid portals selected");

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

    const baseFacts = {
      tipologia: caseRow.property_type,
      indirizzo: caseRow.address_text,
      comune: caseRow.municipality,
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

    const results: Record<string, { output_id: string; version: number; content: unknown } | { error: string }> = {};

    for (const portal of requestedPortals) {
      const rules = PORTAL_RULES[portal];
      const userMsg = `Portale: ${portal}\nTono richiesto: ${rules.tono}\nLimite titolo: ${rules.titolo_max} caratteri\nLimite descrizione: ${rules.descrizione_max} caratteri\n\nDati immobile:\n${JSON.stringify(baseFacts, null, 2)}\n\nProduci JSON.`;

      const aiResp = await fetch(LOVABLE_AI_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: LISTING_SYSTEM_PROMPT },
            { role: "user", content: userMsg },
          ],
          response_format: { type: "json_object" },
        }),
      });

      if (!aiResp.ok) {
        results[portal] = { error: `AI ${aiResp.status}` };
        continue;
      }
      const aiJson = await aiResp.json();
      const raw = aiJson?.choices?.[0]?.message?.content ?? "{}";
      let content: Record<string, unknown> = {};
      try { content = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { content = { raw }; }

      const kind = KIND_MAP[portal];
      const { data: prev } = await serviceClient
        .from("civiko_one_generated_outputs")
        .select("version")
        .eq("case_id", case_id)
        .eq("kind", kind)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextVersion = (prev?.version ?? 0) + 1;

      const { data: saved, error: saveErr } = await serviceClient
        .from("civiko_one_generated_outputs")
        .insert({
          case_id, agency_id: agencyId, generated_by: userId,
          kind, version: nextVersion, content_jsonb: content, model_used: MODEL,
        })
        .select("id, version")
        .single();

      if (saveErr || !saved) {
        results[portal] = { error: saveErr?.message ?? "save failed" };
      } else {
        results[portal] = { output_id: saved.id, version: saved.version, content };
      }
    }

    return jsonResponse({ ok: true, data: { portals: results } });
  } catch (e) {
    return errorResponse("INTERNAL_ERROR", e instanceof Error ? e.message : String(e), 500);
  }
});
