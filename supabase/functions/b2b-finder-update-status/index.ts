// b2b-finder-update-status — Step 6: update commercial status and notes for a saved b2b company.
// No Overpass / Firecrawl / AI / Perplexity / messaging.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders, handlePreflight, pickOrigin } from "../_shared/b2b/cors.ts";
import { authorizeB2BFinder } from "../_shared/b2b/auth.ts";

const STATUS_UI_TO_DB: Record<string, string> = {
  to_contact: "new",
  contacted: "contacted",
  interested: "interested",
  quote_sent: "quote_sent",
  awaiting_payment: "awaiting_payment",
  won: "won",
  lost: "lost",
  later: "later",
  discarded: "excluded",
};

const STATUS_DB_TO_UI: Record<string, string> = {
  new: "to_contact",
  contacted: "contacted",
  interested: "interested",
  quote_sent: "quote_sent",
  awaiting_payment: "awaiting_payment",
  won: "won",
  lost: "lost",
  later: "later",
  excluded: "discarded",
};

const NOTE_FIELDS = [
  "general",
  "referente",
  "colori_richiesti",
  "quantita_richiesta",
  "giorno_richiamo",
  "esito_chiamata",
  "prossimo_passo",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function newDebugId(): string {
  return "b2bf_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function envelope(
  ok: boolean,
  data: unknown,
  error: string | null,
  debug_id: string,
  warnings: string[] = [],
) {
  return { ok, data, warnings, debug_id, error };
}

function jsonResponse(req: Request, status: number, body: ReturnType<typeof envelope>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json",
      "X-Function": "b2b-finder-update-status",
      "X-Contract": "b2b-finder/v0.2",
    },
  });
}

interface Body {
  company_id?: string;
  contact_status?: string;
  notes?: Record<string, unknown>;
}

function sanitizeNotes(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of NOTE_FIELDS) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    const s = String(v);
    // soft cap to keep DB safe
    out[k] = s.length > 4000 ? s.slice(0, 4000) : s;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  const debug_id = newDebugId();
  try {
    const pre = handlePreflight(req);
    if (pre) return pre;

    if (req.headers.get("origin") && !pickOrigin(req)) {
      return jsonResponse(req, 403, envelope(false, null, "Forbidden origin", debug_id));
    }

    if (req.method !== "POST") {
      return jsonResponse(req, 405, envelope(false, null, "Method not allowed", debug_id));
    }

    const auth = authorizeB2BFinder(req);
    if (!auth.ok) {
      console.warn(`[b2b-finder-update-status] auth rejected debug_id=${debug_id} reason=${auth.reason}`);
      return jsonResponse(req, 401, envelope(false, null, "Unauthorized", debug_id));
    }

    const ct = req.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      return jsonResponse(req, 400, envelope(false, null, "Content-Type must be application/json", debug_id));
    }

    let body: Body;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(req, 400, envelope(false, null, "Invalid JSON body", debug_id));
    }

    const companyId = body.company_id;
    if (!companyId || typeof companyId !== "string" || !UUID_RE.test(companyId)) {
      return jsonResponse(req, 400, envelope(false, null, "Missing or invalid company_id", debug_id));
    }

    const hasStatus = body.contact_status !== undefined && body.contact_status !== null;
    const hasNotes = body.notes !== undefined && body.notes !== null && typeof body.notes === "object";

    if (!hasStatus && !hasNotes) {
      return jsonResponse(req, 400, envelope(false, null, "Provide contact_status and/or notes", debug_id));
    }

    let dbStatus: string | null = null;
    if (hasStatus) {
      const uiStatus = String(body.contact_status);
      if (!(uiStatus in STATUS_UI_TO_DB)) {
        return jsonResponse(req, 400, envelope(false, null, "Invalid contact_status", debug_id));
      }
      dbStatus = STATUS_UI_TO_DB[uiStatus];
    }

    let notesStructured: Record<string, string> | null = null;
    let notesGeneral: string | null = null;
    if (hasNotes) {
      notesStructured = sanitizeNotes(body.notes as Record<string, unknown>);
      if (typeof notesStructured.general === "string") {
        notesGeneral = notesStructured.general;
      }
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.error(`[b2b-finder-update-status] missing env debug_id=${debug_id}`);
      return jsonResponse(req, 500, envelope(false, null, "Server misconfigured", debug_id));
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Load existing row (for metadata merge + existence check)
    const { data: existing, error: selErr } = await supabase
      .from("b2b_companies")
      .select("id,status,notes,metadata")
      .eq("id", companyId)
      .maybeSingle();

    if (selErr) {
      console.error(`[b2b-finder-update-status] select err debug_id=${debug_id} err=${selErr.message}`);
      return jsonResponse(req, 500, envelope(false, null, "DB read failed", debug_id));
    }
    if (!existing) {
      return jsonResponse(req, 404, envelope(false, null, "Company not found", debug_id));
    }

    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (dbStatus !== null) {
      update.status = dbStatus;
    }

    if (notesStructured !== null) {
      const prevMeta = (existing.metadata && typeof existing.metadata === "object")
        ? (existing.metadata as Record<string, unknown>)
        : {};
      const prevStructured = (prevMeta.notes_structured && typeof prevMeta.notes_structured === "object")
        ? (prevMeta.notes_structured as Record<string, unknown>)
        : {};
      const mergedStructured = { ...prevStructured, ...notesStructured };
      update.metadata = { ...prevMeta, notes_structured: mergedStructured };
      if (notesGeneral !== null) {
        update.notes = notesGeneral;
      }
    }

    const { data: updated, error: updErr } = await supabase
      .from("b2b_companies")
      .update(update)
      .eq("id", companyId)
      .select("id,status,updated_at")
      .maybeSingle();

    if (updErr || !updated) {
      console.error(`[b2b-finder-update-status] update err debug_id=${debug_id} err=${updErr?.message ?? "no row"}`);
      return jsonResponse(req, 500, envelope(false, null, "DB update failed", debug_id));
    }

    const finalDbStatus = (updated.status as string) ?? (existing.status as string) ?? "new";
    return jsonResponse(
      req,
      200,
      envelope(
        true,
        {
          company_id: updated.id,
          contact_status: STATUS_DB_TO_UI[finalDbStatus] ?? finalDbStatus,
          db_status: finalDbStatus,
          updated_at: updated.updated_at,
        },
        null,
        debug_id,
      ),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    console.error(`[b2b-finder-update-status] unhandled debug_id=${debug_id} err=${msg}`);
    return new Response(
      JSON.stringify({ ok: false, data: null, warnings: [], debug_id, error: "Internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
