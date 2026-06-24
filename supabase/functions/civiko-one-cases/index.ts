// Civiko One Rebuild — case lifecycle endpoint.
// Most CRUD is done directly from the PWA via PostgREST (RLS protected).
// This function handles operations that need server-side logic:
//   POST /create-with-checklist  → creates a case + seeds standard doc checklist
//   POST /seed-checklist          → re-seeds checklist for an existing case
//
// Auth: end-user JWT + active agency membership.

import { authorizeCivikoOne, civikoOneCors, errorResponse, jsonResponse } from "../_shared/civikoOneAuth.ts";

// Standard owner-side document checklist for an Italian residential property.
const DEFAULT_DOC_CHECKLIST: Array<{ doc_type: string; display_name: string; required: boolean }> = [
  { doc_type: "atto_provenienza", display_name: "Atto di provenienza", required: true },
  { doc_type: "visura_catastale", display_name: "Visura catastale", required: true },
  { doc_type: "planimetria_catastale", display_name: "Planimetria catastale", required: true },
  { doc_type: "ape", display_name: "Attestato Prestazione Energetica (APE)", required: true },
  { doc_type: "agibilita", display_name: "Certificato di agibilità", required: false },
  { doc_type: "regolarita_urbanistica", display_name: "Regolarità urbanistica", required: true },
  { doc_type: "impianti_conformi", display_name: "Dichiarazioni di conformità impianti", required: false },
  { doc_type: "regolamento_condominio", display_name: "Regolamento di condominio", required: false },
  { doc_type: "ultime_spese_condominiali", display_name: "Ultime spese condominiali", required: false },
  { doc_type: "documento_proprietario", display_name: "Documento d'identità proprietario", required: true },
  { doc_type: "codice_fiscale_proprietario", display_name: "Codice fiscale proprietario", required: true },
];

interface CreateCaseBody {
  agency_id: string;
  title: string;
  address_text?: string;
  cap?: string;
  municipality?: string;
  province?: string;
  property_type?: string;
  rooms?: number;
  bathrooms?: number;
  surface_mq?: number;
  ask_price?: number;
  assigned_agent_id?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: civikoOneCors });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/civiko-one-cases\/?/, "").replace(/\/$/, "");

  try {
    if (req.method !== "POST") {
      return errorResponse("METHOD_NOT_ALLOWED", "Use POST", 405);
    }

    const body = await req.json().catch(() => ({})) as Partial<CreateCaseBody> & { case_id?: string };

    if (path === "create-with-checklist") {
      if (!body.title || typeof body.title !== "string" || body.title.trim().length < 2) {
        return errorResponse("TITLE_REQUIRED", "title must be at least 2 chars");
      }
      const auth = await authorizeCivikoOne(req, body.agency_id);
      if (!auth.ok) return errorResponse(auth.code, auth.message, auth.status);

      const { serviceClient, userId, agencyId } = auth;

      const { data: created, error: createErr } = await serviceClient
        .from("civiko_one_property_cases")
        .insert({
          agency_id: agencyId,
          created_by: userId,
          assigned_agent_id: body.assigned_agent_id ?? userId,
          title: body.title.trim(),
          address_text: body.address_text ?? null,
          cap: body.cap ?? null,
          municipality: body.municipality ?? null,
          province: body.province ?? null,
          property_type: body.property_type ?? null,
          rooms: body.rooms ?? null,
          bathrooms: body.bathrooms ?? null,
          surface_mq: body.surface_mq ?? null,
          ask_price: body.ask_price ?? null,
          status: "draft",
        })
        .select("id")
        .single();

      if (createErr || !created) {
        return errorResponse("CREATE_FAILED", createErr?.message ?? "insert failed", 500);
      }

      const rows = DEFAULT_DOC_CHECKLIST.map((d) => ({
        case_id: created.id,
        agency_id: agencyId,
        doc_type: d.doc_type,
        display_name: d.display_name,
        required: d.required,
        status: "missing",
      }));
      const { error: docsErr } = await serviceClient
        .from("civiko_one_property_documents")
        .insert(rows);

      if (docsErr) {
        // Soft-fail: case exists, checklist can be seeded later.
        return jsonResponse({
          ok: true,
          data: { case_id: created.id, checklist_seeded: false },
          warnings: [`checklist_insert_failed:${docsErr.message}`],
        });
      }

      return jsonResponse({
        ok: true,
        data: { case_id: created.id, checklist_seeded: true, checklist_items: rows.length },
      });
    }

    if (path === "seed-checklist") {
      if (!body.case_id) return errorResponse("CASE_ID_REQUIRED", "case_id missing");
      const auth = await authorizeCivikoOne(req, body.agency_id);
      if (!auth.ok) return errorResponse(auth.code, auth.message, auth.status);

      const { serviceClient, agencyId } = auth;

      const { data: existing } = await serviceClient
        .from("civiko_one_property_documents")
        .select("doc_type")
        .eq("case_id", body.case_id);

      const have = new Set((existing ?? []).map((r: { doc_type: string }) => r.doc_type));
      const toInsert = DEFAULT_DOC_CHECKLIST.filter((d) => !have.has(d.doc_type)).map((d) => ({
        case_id: body.case_id!,
        agency_id: agencyId,
        doc_type: d.doc_type,
        display_name: d.display_name,
        required: d.required,
        status: "missing",
      }));

      if (toInsert.length === 0) {
        return jsonResponse({ ok: true, data: { inserted: 0, message: "Checklist already complete" } });
      }

      const { error } = await serviceClient
        .from("civiko_one_property_documents")
        .insert(toInsert);

      if (error) return errorResponse("SEED_FAILED", error.message, 500);
      return jsonResponse({ ok: true, data: { inserted: toInsert.length } });
    }

    return errorResponse("UNKNOWN_ROUTE", `Unknown path: ${path}`, 404);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse("INTERNAL_ERROR", msg, 500);
  }
});
