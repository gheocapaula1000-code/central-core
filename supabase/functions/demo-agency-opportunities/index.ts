// demo-agency-opportunities
// GET /functions/v1/demo-agency-opportunities
// Public demo endpoint for PWA connectivity verification.
// Returns clean, fake, non-sensitive mock data with the same schema as agency-opportunities.
// No auth required. No secrets. No raw sources. No proprietary logic.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const ALLOWED_ORIGINS = [
  "https://civikoone.com",
  "https://www.civikoone.com",
  "https://civiko-method-pro.lovable.app",
];
const LOVABLE_SUFFIXES = [".lovable.app", ".lovableproject.com", ".lovable.dev"];

function corsFor(origin: string | null): Record<string, string> {
  let allow = "https://civikoone.com";
  if (origin) {
    const o = origin.toLowerCase();
    try {
      const u = new URL(o);
      if (ALLOWED_ORIGINS.includes(o)) allow = o;
      else if (LOVABLE_SUFFIXES.some((s) => u.hostname.endsWith(s))) allow = o;
      else if (u.hostname === "localhost" || u.hostname.startsWith("127.")) allow = o;
    } catch { /* ignore */ }
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "X-Core-Version": "v3.4.0",
      "X-Function": "demo-agency-opportunities",
    },
  });
}

interface Opportunity {
  id: string;
  title: string;
  territory: string;
  property_type: "residenziale" | "commerciale" | "terreno";
  temperature: "caldo" | "tiepido" | "freddo";
  priority: "alta" | "media" | "bassa";
  assignment_probability: number;
  estimated_value: number;
  commission_potential: number;
  window_label: string;
  commercial_reason: string;
  next_action: string;
  dossier_status: "pronto" | "in_preparazione";
  visible_to_agency: boolean;
}

const DEMO: Opportunity[] = [
  {
    id: "demo_pd_001",
    title: "Quadrilocale da valorizzare",
    territory: "Padova - Arcella",
    property_type: "residenziale",
    temperature: "caldo",
    priority: "alta",
    assignment_probability: 86,
    estimated_value: 320000,
    commission_potential: 9600,
    window_label: "Finestra utile aperta",
    commercial_reason: "Il proprietario potrebbe valutare una proposta strutturata se presentata con comparabili chiari e piano visita.",
    next_action: "Prepara visita entro 48 ore",
    dossier_status: "pronto",
    visible_to_agency: true,
  },
  {
    id: "demo_pd_002",
    title: "Capannone con uffici da riposizionare",
    territory: "Padova Ovest - Limena",
    property_type: "commerciale",
    temperature: "caldo",
    priority: "alta",
    assignment_probability: 82,
    estimated_value: 1650000,
    commission_potential: 49500,
    window_label: "Momento giusto per proporre incarico",
    commercial_reason: "L'immobile merita un piano dedicato per valorizzare metratura, posizione e tempi di vendita.",
    next_action: "Costruisci dossier industriale e script di contatto",
    dossier_status: "pronto",
    visible_to_agency: true,
  },
];

serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsFor(origin);

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, cors);

  return json(DEMO, 200, cors);
});
