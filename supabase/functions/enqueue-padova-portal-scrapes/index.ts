// enqueue-padova-portal-scrapes
// Fase 1A SHADOW MODE — enqueue asincrono verso scraping_queue con processor
// padova_portal_collect_v2. Non invocato da alcun cron. Solo POST autenticato
// via x-job-secret == CENTRAL_CORE_JOB_SECRET. Nessun CORS.
//
// Selezione portali equivalente a selectPortalsForMode() di portalScrapers.ts.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

type Portal = "immobiliare.it" | "idealista.it" | "casa.it" | "subito.it";
type Mode = "soft" | "full";

const ALL_PORTALS: Portal[] = [
  "immobiliare.it",
  "idealista.it",
  "casa.it",
  "subito.it",
];

const MUNICIPALITY = "Padova";
const PROVINCE = "PD";
const SLUG = "padova";

const URL_BUILDERS: Record<Portal, string> = {
  "immobiliare.it": `https://www.immobiliare.it/vendita-case/${SLUG}/?ordinamento=dataModifica`,
  "idealista.it": `https://www.idealista.it/vendita-case/${SLUG}/`,
  "casa.it": `https://www.casa.it/vendita/residenziale/${SLUG}`,
  "subito.it": `https://www.subito.it/annunci-veneto/vendita/case/${SLUG}/`,
};

const FIRECRAWL_WAIT_FOR_MS = 3000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function sha1Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Equivalente a selectPortalsForMode() di portalScrapers.ts.
function selectPortalsForMode(mode: Mode): { portals: Portal[]; rotationKey: string } {
  if (mode === "full") return { portals: ALL_PORTALS.slice(), rotationKey: "full_all" };
  const romaHour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/Rome" })
      .format(new Date()),
  );
  if (romaHour >= 8 && romaHour < 14) {
    return { portals: ["casa.it", "subito.it"], rotationKey: "soft_morning" };
  }
  if (romaHour >= 14 && romaHour < 20) {
    return { portals: ALL_PORTALS.slice(), rotationKey: "soft_afternoon" };
  }
  return {
    portals: ["casa.it", "immobiliare.it", "subito.it"],
    rotationKey: "soft_night",
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const secret = req.headers.get("x-job-secret") ?? "";
  if (!JOB_SECRET || !safeEqual(secret, JOB_SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: { mode?: Mode; portals?: string[] } = {};
  try {
    body = (await req.json().catch(() => ({}))) ?? {};
  } catch {
    body = {};
  }

  const mode: Mode = body.mode === "full" ? "full" : "soft";

  let selectedPortals: Portal[];
  let rotationKey: string;
  if (Array.isArray(body.portals) && body.portals.length > 0) {
    // Filtra whitelist + dedupe, mantenendo l'ordine esplicito del chiamante
    const seen = new Set<Portal>();
    const list: Portal[] = [];
    for (const raw of body.portals) {
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
    const sel = selectPortalsForMode(mode);
    selectedPortals = sel.portals;
    rotationKey = sel.rotationKey;
  }

  if (selectedPortals.length === 0) {
    return json({ ok: true, mode, rotation_key: rotationKey, enqueued: [], skipped: [] });
  }

  const priority = mode === "full" ? 700 : 500;
  const date = utcDate();
  const enqueued: Array<{
    portal: Portal; queue_id: string | null; url: string; idempotency_key: string;
  }> = [];
  const skipped: Array<{ portal: Portal; reason: string }> = [];

  for (const portal of selectedPortals) {
    const url = URL_BUILDERS[portal];
    if (!url) {
      skipped.push({ portal, reason: "no_url" });
      continue;
    }
    const urlHash = (await sha1Hex(url)).slice(0, 16);
    const idempotency_key = `padova_portal:${date}:${portal}:${mode}:${urlHash}`;

    const payload = {
      url,
      formats: ["markdown"],
      onlyMainContent: false,
      waitFor: FIRECRAWL_WAIT_FOR_MS,
    };
    const processor_context = {
      municipality: MUNICIPALITY,
      province: PROVINCE,
      portal,
      mode,
    };
    const group_key = `radar:padova:portal:${portal}`;

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
        portal, mode, code: error.code, message: error.message,
      });
      skipped.push({ portal, reason: `enqueue_error:${error.code ?? "unknown"}` });
      continue;
    }
    enqueued.push({
      portal,
      queue_id: typeof data === "string"
        ? data
        : (data as { id?: string } | null)?.id ?? null,
      url,
      idempotency_key,
    });
  }

  return json({ ok: true, mode, rotation_key: rotationKey, enqueued, skipped });
});
