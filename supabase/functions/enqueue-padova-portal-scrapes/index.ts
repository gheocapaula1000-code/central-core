// enqueue-padova-portal-scrapes
// Fase 1B SHADOW MODE — enqueue asincrono verso scraping_queue con processor
// padova_portal_collect_v2. Accoda esclusivamente PAGINA 1 di ogni portale
// selezionato. Le pagine successive vengono accodate dal
// scraping-result-processor dopo il salvataggio della pagina precedente.
//
// Invocato da pg_cron `padova-portal-scrapes-full` e dall'orchestratore
// (portal_casa). Auth: x-job-secret / x-internal-secret / Bearer job secret
// == CENTRAL_CORE_JOB_SECRET. Nessun CORS.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  isJobSecretAuthorized,
  jobAuthFailure,
} from "../_shared/jobAuth.ts";
import {
  ALL_PORTALS,
  buildPageGroupKey,
  buildPageIdempotencyKey,
  buildPortalPageUrl,
  getAbsoluteMaxPages,
  getDefaultMaxPages,
  type Mode,
  type Portal,
} from "../_shared/queue-processors/padovaPortalPages.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const MUNICIPALITY = "Padova";
const PROVINCE = "PD";
const FIRECRAWL_WAIT_FOR_MS = 3000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}


async function sha1Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// YYYY-MM-DD in Europe/Rome basato su `now`, coerente con la stessa istanza.
function romeDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "00";
  const d = parts.find((p) => p.type === "day")?.value ?? "00";
  return `${y}-${m}-${d}`;
}

function romeHour(now: Date): number {
  const s = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", hour12: false, timeZone: "Europe/Rome",
  }).format(now);
  return Number(s);
}

// Equivalente a selectPortalsForMode() di portalScrapers.ts.
function selectPortalsForMode(mode: Mode, now: Date): { portals: Portal[]; rotationKey: string } {
  if (mode === "full") return { portals: ALL_PORTALS.slice(), rotationKey: "full_all" };
  const h = romeHour(now);
  if (h >= 8 && h < 14) {
    return { portals: ["casa.it", "subito.it"], rotationKey: "soft_morning" };
  }
  if (h >= 14 && h < 20) {
    return { portals: ALL_PORTALS.slice(), rotationKey: "soft_afternoon" };
  }
  return {
    portals: ["casa.it", "immobiliare.it", "subito.it"],
    rotationKey: "soft_night",
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!JOB_SECRET || !isJobSecretAuthorized(req.headers, JOB_SECRET)) {
    const auth = jobAuthFailure(Boolean(JOB_SECRET));
    return json({ error: auth.error }, auth.status);
  }

  // Body: assente (req.body === null) → default soft.
  // Presente ma non-object JSON o vuoto/whitespace → 400 invalid_json.
  let body: Record<string, unknown> = {};
  if (req.body !== null) {
    const raw = await req.text();
    if (raw.trim().length === 0) {
      return json({ error: "invalid_json" }, 400);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return json({ error: "invalid_json" }, 400);
    }
    body = parsed as Record<string, unknown>;
  }

  // mode: assente → soft; presente → deve essere esattamente "soft" o "full".
  let mode: Mode;
  if (!("mode" in body)) {
    mode = "soft";
  } else if (body.mode === "soft" || body.mode === "full") {
    mode = body.mode;
  } else {
    return json({ error: "invalid_mode" }, 400);
  }

  // max_pages: assente → default; presente → deve essere intero nel range.
  let max_pages: number;
  if (!("max_pages" in body)) {
    max_pages = getDefaultMaxPages(mode);
  } else {
    const raw = body.max_pages;
    if (
      typeof raw !== "number" ||
      !Number.isFinite(raw) ||
      !Number.isInteger(raw) ||
      raw < 1 ||
      raw > getAbsoluteMaxPages(mode)
    ) {
      return json({ error: "invalid_max_pages" }, 400);
    }
    max_pages = raw;
  }

  // portals
  const now = new Date();
  let selectedPortals: Portal[];
  let rotationKey: string;

  if ("portals" in body) {
    if (!Array.isArray(body.portals)) {
      return json({ error: "invalid_portals" }, 400);
    }
    const seen = new Set<Portal>();
    const list: Portal[] = [];
    for (const raw of body.portals as unknown[]) {
      if (typeof raw !== "string") continue;
      const p = raw as Portal;
      if (!ALL_PORTALS.includes(p)) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      list.push(p);
    }
    selectedPortals = list;
    rotationKey = "explicit";
  } else {
    const sel = selectPortalsForMode(mode, now);
    selectedPortals = sel.portals;
    rotationKey = sel.rotationKey;
  }

  const run_date = romeDate(now);

  if (selectedPortals.length === 0) {
    return json({
      ok: true, mode, rotation_key: rotationKey, max_pages,
      enqueued: [], skipped: [],
    });
  }

  const basePriority = mode === "full" ? 700 : 500;
  const PAGE = 1; // Enqueue accoda esclusivamente pagina 1.
  const priority = basePriority - (PAGE - 1);

  const enqueued: Array<{
    portal: Portal; page: number; queue_id: string; url: string; idempotency_key: string;
  }> = [];
  const skipped: Array<{ portal: Portal; reason: string }> = [];
  let hadError = false;

  for (const portal of selectedPortals) {
    const url = buildPortalPageUrl(portal, PAGE);
    const urlHash16 = (await sha1Hex(url)).slice(0, 16);
    const idempotency_key = buildPageIdempotencyKey({
      runDate: run_date, portal, mode, page: PAGE, urlHash16,
    });

    const payload = {
      url,
      formats: ["markdown"],
      onlyMainContent: false,
      waitFor: FIRECRAWL_WAIT_FOR_MS,
      proxy: "auto",
    };
    const processor_context = {
      municipality: MUNICIPALITY,
      province: PROVINCE,
      portal,
      mode,
      page: PAGE,
      max_pages,
      run_date,
    };
    const group_key = buildPageGroupKey(portal);

    const { data, error } = await sb.rpc("scraping_enqueue_processed", {
      p_provider: "firecrawl",
      p_operation: "scrape",
      p_payload: payload,
      p_processor: "padova_portal_collect_v2",
      p_processor_context: processor_context,
      p_idempotency_key: idempotency_key,
      p_group_key: group_key,
      p_priority: priority,
      p_max_attempts: 3,
      p_timeout_seconds: 45,
      p_processing_max_attempts: 5,
    });

    if (error) {
      console.error("[enqueue-padova-portal-scrapes] enqueue_error", {
        portal, mode, page: PAGE, code: error.code, message: error.message,
      });
      skipped.push({ portal, reason: `enqueue_error:${error.code ?? "unknown"}` });
      hadError = true;
      continue;
    }
    const rawId =
      typeof data === "string"
        ? data
        : (data as { id?: unknown } | null)?.id;
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof rawId !== "string" || !UUID_RE.test(rawId)) {
      console.error("[enqueue-padova-portal-scrapes] invalid_enqueue_result", {
        portal, mode, page: PAGE, received_type: typeof data,
      });
      skipped.push({ portal, reason: "invalid_enqueue_result" });
      hadError = true;
      continue;
    }
    enqueued.push({
      portal, page: PAGE, queue_id: rawId, url, idempotency_key,
    });
  }

  const respBody = {
    ok: !hadError,
    mode,
    rotation_key: rotationKey,
    max_pages,
    enqueued,
    skipped,
  };
  return json(respBody, hadError ? 502 : 200);
});
