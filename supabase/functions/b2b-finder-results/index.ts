// b2b-finder-results — Step 5: read-only access to saved b2b_search_jobs and their companies.
// Overpass/AI/Firecrawl NOT used. Service role for DB reads.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders, handlePreflight, pickOrigin } from "../_shared/b2b/cors.ts";
import { authorizeB2BFinder } from "../_shared/b2b/auth.ts";

const VERTICAL = "coprimacchia_tnt";
const MODE = "buyers";

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

const PRIORITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

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
      "X-Function": "b2b-finder-results",
      "X-Contract": "b2b-finder/v0.6",
    },
  });
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

interface Body {
  route?: string;
  limit?: number;
  offset?: number;
  job_id?: string;
  filters?: {
    priority?: string;
    status?: string;
    has_phone?: boolean;
    has_website?: boolean;
  };
  sort?: string;
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
      console.warn(`[b2b-finder-results] auth rejected debug_id=${debug_id} reason=${auth.reason}`);
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

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.error(`[b2b-finder-results] missing env debug_id=${debug_id}`);
      return jsonResponse(req, 500, envelope(false, null, "Server misconfigured", debug_id));
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const route = body.route;

    // ── list_jobs ────────────────────────────────────────────────────────
    if (route === "list_jobs") {
      const limit = clampInt(body.limit, 20, 1, 100);
      const offset = clampInt(body.offset, 0, 0, 100000);

      const { data: jobs, error } = await supabase
        .from("b2b_search_jobs")
        .select("id,created_at,finished_at,product,mode,status,zone,counts,cost_eur")
        .eq("vertical", VERTICAL)
        .eq("mode", MODE)
        .not("product", "ilike", "%buste portaposate%")
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);


      if (error) {
        console.error(`[b2b-finder-results] list_jobs error debug_id=${debug_id} err=${error.message}`);
        return jsonResponse(req, 500, envelope(false, null, "DB read failed", debug_id));
      }

      const out = (jobs ?? []).map((j: Record<string, unknown>) => {
        const zone = (j.zone ?? {}) as Record<string, unknown>;
        const counts = (j.counts ?? {}) as Record<string, unknown>;
        return {
          job_id: j.id,
          created_at: j.created_at,
          finished_at: j.finished_at,
          product: j.product,
          mode: j.mode,
          status: j.status,
          city: zone.city ?? null,
          province: zone.province ?? null,
          total_found: counts.total_found ?? 0,
          sample_count: counts.sample_count ?? 0,
          saved_count: counts.saved_count ?? 0,
          high_priority: counts.high_priority ?? 0,
          medium_priority: counts.medium_priority ?? 0,
          low_priority: counts.low_priority ?? 0,
          cost_eur: Number(j.cost_eur ?? 0),
        };
      });

      return jsonResponse(req, 200, envelope(true, { jobs: out, limit, offset }, null, debug_id));
    }

    // ── get_job_results ──────────────────────────────────────────────────
    if (route === "get_job_results") {
      const jobId = body.job_id;
      if (!jobId || typeof jobId !== "string") {
        return jsonResponse(req, 400, envelope(false, null, "Missing job_id", debug_id));
      }
      // UUID sanity
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
        return jsonResponse(req, 400, envelope(false, null, "Invalid job_id format", debug_id));
      }

      // Confirm job exists and belongs to module
      const { data: jobRow, error: jobErr } = await supabase
        .from("b2b_search_jobs")
        .select("id,vertical,mode,zone")
        .eq("id", jobId)
        .maybeSingle();
      if (jobErr) {
        console.error(`[b2b-finder-results] job lookup err debug_id=${debug_id} err=${jobErr.message}`);
        return jsonResponse(req, 500, envelope(false, null, "DB read failed", debug_id));
      }
      if (!jobRow) {
        return jsonResponse(req, 404, envelope(false, null, "Job not found", debug_id));
      }
      if (jobRow.vertical !== VERTICAL || jobRow.mode !== MODE) {
        return jsonResponse(req, 404, envelope(false, null, "Job not found", debug_id));
      }

      const limit = clampInt(body.limit, 100, 1, 500);
      const offset = clampInt(body.offset, 0, 0, 100000);
      const filters = body.filters ?? {};
      const sort = body.sort ?? "score_desc";

      // Get distinct company_ids from sources (the relationship table)
      // Fetch sources to derive last_seen via fetched_at as needed
      const { data: srcRows, error: srcErr } = await supabase
        .from("b2b_company_sources")
        .select("company_id,source,source_ref,fetched_at")
        .eq("job_id", jobId);
      if (srcErr) {
        console.error(`[b2b-finder-results] sources err debug_id=${debug_id} err=${srcErr.message}`);
        return jsonResponse(req, 500, envelope(false, null, "DB read failed", debug_id));
      }

      const sourceByCompany = new Map<string, { source: string; source_ref: string | null; fetched_at: string | null }>();
      for (const s of srcRows ?? []) {
        const cid = s.company_id as string;
        if (!sourceByCompany.has(cid)) {
          sourceByCompany.set(cid, {
            source: (s.source as string) ?? "overpass",
            source_ref: (s.source_ref as string | null) ?? null,
            fetched_at: (s.fetched_at as string | null) ?? null,
          });
        }
      }
      const companyIds = Array.from(sourceByCompany.keys());

      if (companyIds.length === 0) {
        return jsonResponse(
          req,
          200,
          envelope(true, { job_id: jobId, results: [], count: 0, limit, offset }, null, debug_id),
        );
      }

      // Build query on b2b_companies with filters
      let q = supabase
        .from("b2b_companies")
        .select(
          "id,name,category,address,comune,provincia,regione,phone,email,website,priority,score,fit_reason,status,notes,last_seen_at,metadata",
        )
        .in("id", companyIds);

      if (filters.priority && ["high", "medium", "low"].includes(filters.priority)) {
        q = q.eq("priority", filters.priority);
      }
      if (filters.status && STATUS_UI_TO_DB[filters.status]) {
        q = q.eq("status", STATUS_UI_TO_DB[filters.status]);
      }
      if (filters.has_phone === true) q = q.not("phone", "is", null);
      if (filters.has_website === true) q = q.not("website", "is", null);

      const { data: companies, error: cErr } = await q;
      if (cErr) {
        console.error(`[b2b-finder-results] companies err debug_id=${debug_id} err=${cErr.message}`);
        return jsonResponse(req, 500, envelope(false, null, "DB read failed", debug_id));
      }

      // Rollback v0.7 — hide any legacy record from suppliers mode or buste_portaposate_airlaid product
      const filteredCompanies = (companies ?? []).filter((c: Record<string, unknown>) => {
        const md = (c.metadata as Record<string, unknown> | null) ?? {};
        const sm = String((md.search_mode ?? "")).toLowerCase();
        const pk = String((md.product_key ?? "")).toLowerCase();
        if (sm === "suppliers") return false;
        if (pk === "buste_portaposate_airlaid") return false;
        return true;
      });
      const mapped = filteredCompanies.map((c: Record<string, unknown>) => {

        const src = sourceByCompany.get(c.id as string);
        const dbStatus = (c.status as string) ?? "new";
        const metadata = (c.metadata as Record<string, unknown> | null) ?? {};
        const enrichment = (metadata.enrichment as Record<string, unknown> | null) ?? {};
        return {
          company_id: c.id,
          company_name: c.name,
          company_type: "buyer_candidate",
          category: c.category ?? null,
          sector: "ristorazione",
          city: c.comune ?? null,
          province: c.provincia ?? null,
          region: c.regione ?? null,
          address: c.address ?? null,
          website: c.website ?? null,
          phone: c.phone ?? null,
          email: c.email ?? null,
          source_type: src?.source ?? "overpass",
          source_ref: src?.source_ref ?? null,
          fit_reason: c.fit_reason ?? null,
          priority: c.priority ?? "low",
          score: Number(c.score ?? 0),
          contact_status: STATUS_DB_TO_UI[dbStatus] ?? dbStatus,
          notes: c.notes ?? "",
          last_seen_at: c.last_seen_at ?? src?.fetched_at ?? null,
          ready_to_contact: (enrichment.ready_to_contact as boolean | undefined) ?? false,
          buyer_fit_score: (enrichment.buyer_fit_score as number | null | undefined) ?? null,
          contactability_score: (enrichment.contactability_score as number | null | undefined) ?? null,
          data_completeness_score: (enrichment.data_completeness_score as number | null | undefined) ?? null,
          next_best_action: (enrichment.next_best_action as string | null | undefined) ?? null,
          // v0.5 commercial top-level mirrors (PWA can use these without opening enrichment)
          priority_label: (enrichment.priority_label as string | null | undefined) ?? null,
          status_suggestion: (enrichment.status_suggestion as string | null | undefined) ?? null,
          contact_channel_recommendation: (enrichment.contact_channel_recommendation as string | null | undefined) ?? null,
          // v0.6 phone discovery top-level mirrors
          phone_href: (enrichment.phone_href as string | null | undefined) ?? null,
          phone_pretty: (enrichment.phone_pretty as string | null | undefined) ?? null,
          missing_data: (enrichment.missing_data as unknown[] | undefined) ?? [],
          verification_checks: (enrichment.verification_checks as unknown[] | undefined) ?? [],
          phone_discovery: (enrichment.phone_discovery as Record<string, unknown> | null | undefined) ?? null,
          enrichment: {
            category_refined:
              (enrichment.category_refined as string | null | undefined) ??
              (enrichment.refined_category as string | null | undefined) ??
              null,
            contact_page: (enrichment.contact_page as string | null | undefined) ?? null,
            social_links: (enrichment.social_links as unknown[] | undefined) ?? [],
            commercial_signals: (enrichment.commercial_signals as unknown[] | undefined) ?? [],
            enriched_at: (enrichment.enriched_at as string | null | undefined) ?? null,
            cost_eur:
              (enrichment.total_cost_eur as number | null | undefined) ??
              (enrichment.cost_eur as number | null | undefined) ??
              null,
            sources_consulted:
              (enrichment.sources_consulted as unknown[] | undefined) ??
              (enrichment.public_sources_used as unknown[] | undefined) ??
              (enrichment.source_urls as unknown[] | undefined) ??
              (enrichment.providers_used as unknown[] | undefined) ??
              [],
            // v0.5 commercial fields (additive; legacy clients ignore unknown keys)
            priority_label: (enrichment.priority_label as string | null | undefined) ?? null,
            status_suggestion: (enrichment.status_suggestion as string | null | undefined) ?? null,
            buyer_fit_reason: (enrichment.buyer_fit_reason as string | null | undefined) ?? null,
            exclusion_reason: (enrichment.exclusion_reason as string | null | undefined) ?? null,
            business_summary: (enrichment.business_summary as string | null | undefined) ?? null,
            product_use_case: (enrichment.product_use_case as string | null | undefined) ?? null,
            decision_maker_hint: (enrichment.decision_maker_hint as string | null | undefined) ?? null,
            contact_channel_recommendation: (enrichment.contact_channel_recommendation as string | null | undefined) ?? null,
            call_opener: (enrichment.call_opener as string | null | undefined) ?? null,
            whatsapp_or_email_message: (enrichment.whatsapp_or_email_message as string | null | undefined) ?? null,
            missing_data: (enrichment.missing_data as unknown[] | undefined) ?? [],
            verification_checks: (enrichment.verification_checks as unknown[] | undefined) ?? [],
            public_sources_used: (enrichment.public_sources_used as unknown[] | undefined) ?? [],
            confidence: (enrichment.confidence as number | null | undefined) ?? null,
            ready_to_contact: (enrichment.ready_to_contact as boolean | undefined) ?? false,
            buyer_fit_score: (enrichment.buyer_fit_score as number | null | undefined) ?? null,
            contactability_score: (enrichment.contactability_score as number | null | undefined) ?? null,
            data_completeness_score: (enrichment.data_completeness_score as number | null | undefined) ?? null,
            next_best_action: (enrichment.next_best_action as string | null | undefined) ?? null,
            // v0.6 phone discovery (nested mirror for legacy clients reading enrichment.*)
            phone_href: (enrichment.phone_href as string | null | undefined) ?? null,
            phone_pretty: (enrichment.phone_pretty as string | null | undefined) ?? null,
            phone_discovery: (enrichment.phone_discovery as Record<string, unknown> | null | undefined) ?? null,
          },
        };
      });

      // Sort
      const sorted = [...mapped];
      switch (sort) {
        case "priority":
          sorted.sort(
            (a, b) =>
              (PRIORITY_RANK[b.priority as string] ?? 0) - (PRIORITY_RANK[a.priority as string] ?? 0) ||
              b.score - a.score,
          );
          break;
        case "name":
          sorted.sort((a, b) => String(a.company_name ?? "").localeCompare(String(b.company_name ?? "")));
          break;
        case "status":
          sorted.sort((a, b) => String(a.contact_status).localeCompare(String(b.contact_status)));
          break;
        case "last_seen_desc":
          sorted.sort((a, b) => String(b.last_seen_at ?? "").localeCompare(String(a.last_seen_at ?? "")));
          break;
        case "score_desc":
        default:
          sorted.sort((a, b) => b.score - a.score);
          break;
      }

      const paged = sorted.slice(offset, offset + limit);

      return jsonResponse(
        req,
        200,
        envelope(
          true,
          { job_id: jobId, results: paged, count: paged.length, limit, offset },
          null,
          debug_id,
        ),
      );
    }

    return jsonResponse(req, 400, envelope(false, null, "Unknown route", debug_id));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    console.error(`[b2b-finder-results] unhandled debug_id=${debug_id} err=${msg}`);
    try {
      return jsonResponse(req, 500, envelope(false, null, "Internal error", debug_id));
    } catch {
      return new Response(
        JSON.stringify({ ok: false, data: null, warnings: [], debug_id, error: "Internal error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }
});
