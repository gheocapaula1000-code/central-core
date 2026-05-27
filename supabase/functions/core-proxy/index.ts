// core-proxy — Edge Function
// Proxy sicuro dalla PWA alle edge functions del Core.
// La PWA non chiama mai direttamente le edge functions: passa sempre qui.
// Whitelist esplicita: solo i path autorizzati vengono inoltrati.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Whitelist path autorizzati → nome edge function di destinazione
const ROUTE_MAP: Record<string, string> = {
  // ── Civiko V1 (esistenti) ──
  "civiko/property-source-profile":      "civiko-property-source-profile",
  "civiko/property-hyperlocal-signals":  "civiko-property-hyperlocal-signals",
  "civiko/property-zona-in-movimento":   "civiko-property-zona-in-movimento",
  "civiko/property-piano-esclusiva":     "civiko-property-piano-esclusiva",
  "civiko/property-objection-plan":      "civiko-property-objection-plan",
  "civiko/property-owner-report":        "civiko-property-owner-report",
  "civiko/billing/create-checkout":      "civiko-billing",
  "civiko/billing/customer-portal":      "civiko-billing",
  "civiko/billing/check-subscription":   "civiko-billing",
  "civiko/billing/record-usage":         "civiko-billing",
  "civiko/billing/stripe-webhook":       "civiko-billing",
  // ── Padova Pilot (nuovi) ──
  "civiko/tram-padova":                  "civiko-tram-padova",
  "civiko/pnrr-padova":                  "civiko-pnrr-padova",
  "civiko/omi-padova-zone":              "civiko-omi-padova-zone",
  "civiko/places-padova":                "civiko-places-padova",
  "civiko/dossier-padova":               "civiko-dossier-padova",
  "civiko/dossier-pdf":                  "civiko-dossier-pdf",
  // ── Diagnostica ──
  "health":                              "health",
  "core-status":                         "core-status",
  "connector-status":                    "connector-status",
};

// Path che usano ancora il vecchio router sottra (legacy V1)
const SOTTRA_ROUTES = new Set([
  "civiko/property-source-profile",
  "civiko/property-hyperlocal-signals",
  "civiko/property-zona-in-movimento",
  "civiko/property-piano-esclusiva",
  "civiko/property-objection-plan",
  "civiko/property-owner-report",
]);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? `Bearer ${ANON_KEY}`;

  let body: { endpoint?: string; method?: string; payload?: unknown; timeout?: number } = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Body JSON non valido" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const { endpoint, method = "POST", payload, timeout = 15000 } = body;
  if (!endpoint) {
    return new Response(JSON.stringify({ error: "Campo 'endpoint' obbligatorio" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const normalizedEndpoint = endpoint.replace(/^\//, "");
  const targetFunction = ROUTE_MAP[normalizedEndpoint];

  if (!targetFunction) {
    console.warn(`[core-proxy] endpoint non autorizzato: ${normalizedEndpoint}`);
    return new Response(JSON.stringify({ error: "Endpoint non autorizzato", endpoint: normalizedEndpoint }), { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout + 2000);

  try {
    let targetUrl: string;
    let requestBody: unknown;

    if (SOTTRA_ROUTES.has(normalizedEndpoint)) {
      targetUrl = `${SUPABASE_URL}/functions/v1/sottra`;
      requestBody = { route: normalizedEndpoint, ...(typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {}) };
    } else {
      targetUrl = `${SUPABASE_URL}/functions/v1/${targetFunction}`;
      requestBody = payload ?? {};
    }

    const res = await fetch(targetUrl, {
      method,
      headers: { "Content-Type": "application/json", "Authorization": authHeader, "apikey": ANON_KEY },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timer);

    // Il dossier-pdf ritorna binary — inoltra così com'è preservando Content-Type
    if (targetFunction === "civiko-dossier-pdf") {
      const upstreamCT = res.headers.get("Content-Type") ?? "";
      // Se l'upstream non è 2xx O non è application/pdf, passa attraverso come JSON di errore
      if (!res.ok || !upstreamCT.includes("application/pdf")) {
        const text = await res.text();
        let errBody: unknown;
        try { errBody = JSON.parse(text); } catch { errBody = { error: true, message: text || "PDF upstream error" }; }
        return new Response(JSON.stringify(errBody), {
          status: res.ok ? 502 : res.status,
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
      const pdfBytes = await res.arrayBuffer();
      return new Response(pdfBytes, {
        status: res.status,
        headers: {
          ...CORS,
          "Content-Type": "application/pdf",
          "Content-Disposition": res.headers.get("Content-Disposition") ?? `attachment; filename="civiko-dossier-padova.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const data = await res.json();
    return new Response(JSON.stringify(data), { status: res.status, headers: { ...CORS, "Content-Type": "application/json" } });

  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return new Response(
      JSON.stringify({ error: true, message: aborted ? "Il servizio non ha risposto in tempo. Riprova tra qualche istante." : (e instanceof Error ? e.message : "Errore proxy") }),
      { status: aborted ? 504 : 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
