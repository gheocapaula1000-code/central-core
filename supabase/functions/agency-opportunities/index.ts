// agency-opportunities
// GET /functions/v1/agency-opportunities
// Returns clean, PWA-safe commercial opportunities (mock data for now).
// Auth: Bearer JWT required. Role: agency_user | admin | owner.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const ALLOWED_ORIGINS = [
  "https://civikoone.com",
  "https://www.civikoone.com",
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
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const OWNER_EMAILS = (Deno.env.get("OWNER_EMAILS") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

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

const MOCK: Opportunity[] = [
  {
    id: "opp_pd_001",
    title: "Quadrilocale da valorizzare",
    territory: "Padova - Arcella",
    property_type: "residenziale",
    temperature: "caldo",
    priority: "alta",
    assignment_probability: 84,
    estimated_value: 320000,
    commission_potential: 9600,
    window_label: "Finestra utile aperta",
    commercial_reason: "Il proprietario può valutare una proposta concreta entro pochi giorni.",
    next_action: "Prepara visita entro 48 ore",
    dossier_status: "pronto",
    visible_to_agency: true,
  },
  {
    id: "opp_pd_002",
    title: "Bicamere ristrutturato vicino centro",
    territory: "Padova - Santo",
    property_type: "residenziale",
    temperature: "caldo",
    priority: "alta",
    assignment_probability: 78,
    estimated_value: 245000,
    commission_potential: 7350,
    window_label: "Finestra utile aperta",
    commercial_reason: "Segnali coerenti di apertura al cambio entro il trimestre.",
    next_action: "Contatto telefonico entro 24 ore",
    dossier_status: "pronto",
    visible_to_agency: true,
  },
  {
    id: "opp_pd_003",
    title: "Villetta a schiera con giardino",
    territory: "Selvazzano Dentro",
    property_type: "residenziale",
    temperature: "tiepido",
    priority: "media",
    assignment_probability: 62,
    estimated_value: 410000,
    commission_potential: 12300,
    window_label: "Finestra in apertura",
    commercial_reason: "Contesto familiare in evoluzione, valutazione interna in corso.",
    next_action: "Inviare presentazione personalizzata",
    dossier_status: "pronto",
    visible_to_agency: true,
  },
  {
    id: "opp_pd_004",
    title: "Locale commerciale fronte strada",
    territory: "Padova - Stanga",
    property_type: "commerciale",
    temperature: "tiepido",
    priority: "media",
    assignment_probability: 55,
    estimated_value: 280000,
    commission_potential: 8400,
    window_label: "Finestra in apertura",
    commercial_reason: "Attività in riorganizzazione, possibile rilascio entro 6 mesi.",
    next_action: "Pianifica sopralluogo conoscitivo",
    dossier_status: "in_preparazione",
    visible_to_agency: true,
  },
  {
    id: "opp_pd_005",
    title: "Trilocale da rinfrescare",
    territory: "Abano Terme",
    property_type: "residenziale",
    temperature: "caldo",
    priority: "alta",
    assignment_probability: 71,
    estimated_value: 195000,
    commission_potential: 5850,
    window_label: "Finestra utile aperta",
    commercial_reason: "Esigenza concreta di liquidità nel breve periodo.",
    next_action: "Prepara incontro con stima rapida",
    dossier_status: "pronto",
    visible_to_agency: true,
  },
  {
    id: "opp_pd_006",
    title: "Appartamento con terrazzo",
    territory: "Padova - Forcellini",
    property_type: "residenziale",
    temperature: "tiepido",
    priority: "media",
    assignment_probability: 58,
    estimated_value: 265000,
    commission_potential: 7950,
    window_label: "Finestra in apertura",
    commercial_reason: "Cambio progetto abitativo in valutazione.",
    next_action: "Follow-up entro 7 giorni",
    dossier_status: "pronto",
    visible_to_agency: true,
  },
  {
    id: "opp_pd_007",
    title: "Casa indipendente con corte",
    territory: "Cadoneghe",
    property_type: "residenziale",
    temperature: "freddo",
    priority: "bassa",
    assignment_probability: 34,
    estimated_value: 220000,
    commission_potential: 6600,
    window_label: "Monitoraggio attivo",
    commercial_reason: "Nessuna urgenza, ma profilo da mantenere caldo.",
    next_action: "Inserire in piano nurturing trimestrale",
    dossier_status: "in_preparazione",
    visible_to_agency: true,
  },
];

serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsFor(origin);

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, cors);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return json({ error: "Unauthorized" }, 401, cors);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "Unauthorized" }, 401, cors);
  }
  const user = userData.user;
  const email = (user.email ?? "").toLowerCase();

  // Role check
  let allowed = false;
  if (OWNER_EMAILS.includes(email)) allowed = true;

  if (!allowed && serviceKey) {
    const admin = createClient(supabaseUrl, serviceKey);
    const { data: roles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    const set = new Set((roles ?? []).map((r: { role: string }) => r.role));
    if (set.has("admin") || set.has("owner") || set.has("agency_user")) {
      allowed = true;
    }
  }

  if (!allowed) {
    return json({ error: "Forbidden" }, 403, cors);
  }

  // Optional agency_id filter (mock: all opportunities are agency-agnostic for now)
  const url = new URL(req.url);
  const agencyId = url.searchParams.get("agency_id");

  const items = MOCK.filter((o) => o.visible_to_agency);

  return new Response(JSON.stringify(items), {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "X-Core-Version": "v3.4.0",
      "X-Function": "agency-opportunities",
      "X-Agency-Filter": agencyId ?? "none",
    },
  });
});
