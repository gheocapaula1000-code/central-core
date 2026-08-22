// core-proxy — Edge Function
// Proxy sicuro dalla PWA alle edge functions del Core.
// La PWA non chiama mai direttamente le edge functions: passa sempre qui.
// Whitelist esplicita: solo i path autorizzati vengono inoltrati.
//
// CORS hardening: l'origin viene validata via _shared/http.ts
// (TRUSTED_APP_HOSTS, lovable.*, CORE_ALLOWED_ORIGINS). Le origin sconosciute
// ricevono 403. Niente wildcard `*` in produzione.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, isOriginAllowed, handleOptions } from "../_shared/http.ts";

// Whitelist path autorizzati → nome edge function di destinazione
const ROUTE_MAP: Record<string, string> = {
  // ── Civiko V1 (esistenti) ──
  "civiko/property-source-profile":      "civiko-property-source-profile",
  "civiko/property-hyperlocal-signals":  "civiko-property-hyperlocal-signals",
  "civiko/property-zona-in-movimento":   "civiko-property-zona-in-movimento",
  "civiko/property-piano-esclusiva":     "civiko-property-piano-esclusiva",
  "civiko/property-objection-plan":      "civiko-property-objection-plan",
  "civiko/property-owner-report":        "civiko-property-owner-report",
  "civiko/property-marketing-pack":      "property-marketing-pack",
  "civiko/billing/create-checkout":      "civiko-billing",
  "civiko/billing/customer-portal":      "civiko-billing",
  "civiko/billing/check-subscription":   "civiko-billing",
  "civiko/billing/record-usage":         "civiko-billing",
  "civiko/billing/stripe-webhook":       "civiko-billing",
  "civiko/billing/my-zone":              "civiko-billing",
  "civiko/billing/sales-prospects":      "civiko-billing",
  // ── Padova Pilot (nuovi) ──
  "civiko/tram-padova":                  "civiko-tram-padova",
  "civiko/pnrr-padova":                  "civiko-pnrr-padova",
  "civiko/omi-padova-zone":              "civiko-omi-padova-zone",
  "civiko/places-padova":                "civiko-places-padova",
  "civiko/dossier-padova":               "civiko-dossier-padova",
  "civiko/dossier-pdf":                  "civiko-dossier-pdf",
  // ── Padova contendibili ──
  "padova-contendibili-list":            "padova-contendibili-list",
  "padova-quartieri-stats":              "padova-quartieri-stats",
  "padova-privati-list":                 "padova-privati-list",
  "padova-cambi-agenzia-list":           "padova-cambi-agenzia-list",
  "civiko-one-signals-feed":             "civiko-one-signals-feed",
  // ── Diagnostica ──
  "health":                              "health",
  "core-status":                         "core-status",
  "connector-status":                    "connector-status",
};

const SOTTRA_ROUTES = new Set([
  "civiko/property-source-profile",
  "civiko/property-hyperlocal-signals",
  "civiko/property-zona-in-movimento",
  "civiko/property-piano-esclusiva",
  "civiko/property-objection-plan",
  "civiko/property-owner-report",
]);

// Sottra official engines — forwarded to /functions/v1/sottra/{suffix}
// with x-source-app: sottra. Includes the live PWA photoWow alias
// `/civiko-property-from-photo` (Sottra-only via this proxy; Civiko One
// keeps calling civiko-property-from-photo directly).
const SOTTRA_DIRECT_ROUTES: Record<string, string> = {
  "sottra/photo-wow": "scan/photo-wow",
  "sottra/scan/photo-wow": "scan/photo-wow",
  "photoWow": "scan/photo-wow",
  "photo-wow": "scan/photo-wow",
  "civiko-property-from-photo": "scan/photo-wow",
  "sottra/scan/identify": "scan/identify",
  "sottra/scan/pricing": "scan/pricing",
  "sottra/health": "health",
};

const SOTTRA_DIRECT_GET = new Set(["sottra/health"]);

serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const cors = corsHeaders(req);
  const origin = req.headers.get("origin") ?? "";
  // Server-to-server senza origin → consentito. Origin presente ma non
  // ammessa → 403 esplicito.
  if (origin && !isOriginAllowed(origin)) {
    return new Response(
      JSON.stringify({ error: true, code: "ORIGIN_NOT_ALLOWED", message: "Origin not in allowlist" }),
      { status: 403, headers: { "Content-Type": "application/json", "Vary": "Origin" } },
    );
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? `Bearer ${ANON_KEY}`;

  let body: { endpoint?: string; method?: string; payload?: unknown; timeout?: number } = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Body JSON non valido" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const { endpoint, method = "POST", payload, timeout = 15000 } = body;
  if (!endpoint) {
    return new Response(JSON.stringify({ error: "Campo 'endpoint' obbligatorio" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const normalizedEndpoint = endpoint.replace(/^\//, "");
  const salesProspectsDetailMatch = normalizedEndpoint.match(/^civiko\/billing\/sales-prospects\/[a-f0-9]{40}$/i);
  const sottraSuffix = SOTTRA_DIRECT_ROUTES[normalizedEndpoint];
  const targetFunction = sottraSuffix
    ? "sottra"
    : (ROUTE_MAP[normalizedEndpoint] ?? (salesProspectsDetailMatch ? "civiko-billing" : undefined));

  if (!targetFunction) {
    console.warn(`[core-proxy] endpoint non autorizzato: ${normalizedEndpoint}`);
    return new Response(JSON.stringify({ error: "Endpoint non autorizzato", endpoint: normalizedEndpoint }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout + 2000);

  try {
    let targetUrl: string;
    let requestBody: unknown;
    const upstreamMethod = SOTTRA_DIRECT_GET.has(normalizedEndpoint) ||
      normalizedEndpoint.startsWith("civiko/billing/my-zone") ||
      normalizedEndpoint.startsWith("civiko/billing/sales-prospects")
      ? "GET"
      : method;

    if (sottraSuffix) {
      targetUrl = `${SUPABASE_URL}/functions/v1/sottra/${sottraSuffix}`;
      requestBody = payload ?? {};
    } else if (SOTTRA_ROUTES.has(normalizedEndpoint)) {
      targetUrl = `${SUPABASE_URL}/functions/v1/sottra`;
      requestBody = { route: normalizedEndpoint, ...(typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {}) };
    } else {
      let suffix = "";
      if (normalizedEndpoint.startsWith("civiko/billing/")) {
        suffix = "/" + normalizedEndpoint.substring("civiko/billing/".length);
      }
      targetUrl = `${SUPABASE_URL}/functions/v1/${targetFunction}${suffix}`;
      requestBody = payload ?? {};
    }

    // Base headers. Note: x-internal-secret is NEVER forwarded from the
    // client — it is injected server-side only for routes that require it.
    const upstreamHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": authHeader,
      "apikey": ANON_KEY,
    };

    // Forward workspace identity (x-workspace-id or legacy x-tenant-id alias).
    // Server-side isolation in target functions relies on this header.
    const wsHeader = req.headers.get("x-workspace-id") ?? req.headers.get("x-tenant-id");
    if (wsHeader) {
      upstreamHeaders["x-workspace-id"] = wsHeader;
    }
    // Forward optional user id (for audit only; not authoritative).
    const userHeader = req.headers.get("x-user-id");
    if (userHeader) upstreamHeaders["x-user-id"] = userHeader;

    // Endpoints served to the Civiko One PWA that require the shared internal
    // secret. core-proxy injects it server-side so the PWA never sees it.
    const CIVIKO_ONE_SECRET_ROUTES = new Set<string>([
      "civiko/property-marketing-pack",
      "padova-contendibili-list",
      "padova-privati-list",
      "padova-quartieri-stats",
      "padova-cambi-agenzia-list",
      "civiko-one-signals-feed",
      "civiko/billing/my-zone",
      "civiko/billing/sales-prospects",
    ]);

    if (sottraSuffix) {
      const sottraSecret = Deno.env.get("AI_CORE_SECRET_SOTTRA") || Deno.env.get("AI_CORE_SECRET") || "";
      if (!sottraSecret) {
        clearTimeout(timer);
        return new Response(
          JSON.stringify({
            ok: false,
            data: null,
            warnings: [],
            debug_id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
            error: { code: "UPSTREAM_AUTH_NOT_CONFIGURED", message: "Upstream authentication for this route is not configured." },
          }),
          { status: 503, headers: { ...cors, "Content-Type": "application/json" } },
        );
      }
      upstreamHeaders["x-internal-secret"] = sottraSecret;
      upstreamHeaders["x-source-app"] = "sottra";
    } else if (CIVIKO_ONE_SECRET_ROUTES.has(normalizedEndpoint) || salesProspectsDetailMatch) {
      const civikoSecret = Deno.env.get("AI_CORE_SECRET_CIVIKO") ?? "";
      if (!civikoSecret) {
        clearTimeout(timer);
        return new Response(
          JSON.stringify({
            ok: false,
            data: null,
            warnings: [],
            debug_id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
            error: { code: "UPSTREAM_AUTH_NOT_CONFIGURED", message: "Upstream authentication for this route is not configured." },
          }),
          { status: 503, headers: { ...cors, "Content-Type": "application/json" } },
        );
      }
      upstreamHeaders["x-internal-secret"] = civikoSecret;
      upstreamHeaders["x-source-app"] = normalizedEndpoint.startsWith("civiko/billing/") ? "civiko" : "civiko-one";
    }

    const res = await fetch(targetUrl, {
      method: upstreamMethod,
      headers: upstreamHeaders,
      body: upstreamMethod === "GET" || upstreamMethod === "HEAD" ? undefined : JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (targetFunction === "civiko-dossier-pdf") {
      const upstreamCT = res.headers.get("Content-Type") ?? "";
      if (!res.ok || !upstreamCT.includes("application/pdf")) {
        const text = await res.text();
        let errBody: unknown;
        try { errBody = JSON.parse(text); } catch { errBody = { error: true, message: text || "PDF upstream error" }; }
        return new Response(JSON.stringify(errBody), {
          status: res.ok ? 502 : res.status,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      const pdfBytes = await res.arrayBuffer();
      return new Response(pdfBytes, {
        status: res.status,
        headers: {
          ...cors,
          "Content-Type": "application/pdf",
          "Content-Disposition": res.headers.get("Content-Disposition") ?? `attachment; filename="civiko-dossier-padova.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const data = await res.json();
    return new Response(JSON.stringify(data), { status: res.status, headers: { ...cors, "Content-Type": "application/json" } });

  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return new Response(
      JSON.stringify({ error: true, message: aborted ? "Il servizio non ha risposto in tempo. Riprova tra qualche istante." : (e instanceof Error ? e.message : "Errore proxy") }),
      { status: aborted ? 504 : 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
