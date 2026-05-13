// demo-agency-opportunities
// GET /functions/v1/demo-agency-opportunities
// GET /functions/v1/demo-agency-opportunities?include=owner_dossier
// Demo pubblico per verifica connettività PWA.
// Dati finti, non sensibili, schema identico ad agency-opportunities.
// Nessun campo interno Core, nessuna fonte grezza, nessuna logica proprietaria.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import {
  type OpportunityAgency,
  type OpportunityInternal,
  toAgencyView,
  toOwnerDossier,
  assertAgencySafe,
} from "../_shared/civikoOpportunities.ts";

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

const now = new Date().toISOString();

// Internal Core records (mock). Mai esporre questi oggetti direttamente.
const INTERNAL: Array<{
  internal: OpportunityInternal;
  presentation: Parameters<typeof toAgencyView>[1];
  ownerRange: { min: number; max: number };
  zoneSummary: string;
}> = [
  {
    internal: {
      id: "demo_pd_001",
      territory_id: "padova_e_provincia",
      microzone_id: "arcella",
      property_cluster_id: "quadrilocale_anni70_da_valorizzare",
      internal_signals: ["price_resistance_high", "listing_age_increase", "zone_turnover_steady"],
      internal_sources: [{ name: "internal_signal_aggregator" }],
      source_timestamps: { aggregated_at: now },
      raw_confidence_score: 0.84,
      normalized_priority_score: 86,
      sensitivity_level: "basso",
      data_conflicts: [],
      exclusion_reasons: [],
      provider_cost_estimate_eur: 0,
      last_checked_at: now,
      created_at: now,
      updated_at: now,
    },
    presentation: {
      title: "Quadrilocale da valorizzare",
      territory: "Padova - Arcella",
      microzone: "Arcella",
      property_type: "residenziale",
      estimated_value: 320000,
      commission_potential: 9600,
      commercial_reason:
        "Il proprietario potrebbe valutare una proposta strutturata se presentata con comparabili chiari e piano visita.",
      next_action: "Prepara visita entro 48 ore",
      dossier_status: "pronto",
    },
    ownerRange: { min: 295000, max: 345000 },
    zoneSummary:
      "Zona residenziale consolidata con buona domanda di tagli familiari; tempi di vendita coerenti con il mercato locale.",
  },
  {
    internal: {
      id: "demo_pd_002",
      territory_id: "padova_e_provincia",
      microzone_id: "padova_ovest_limena",
      property_cluster_id: "capannone_uffici_riposizionamento",
      internal_signals: ["industrial_zone_demand_uptick", "comparable_repositioning"],
      internal_sources: [{ name: "internal_signal_aggregator" }],
      source_timestamps: { aggregated_at: now },
      raw_confidence_score: 0.78,
      normalized_priority_score: 82,
      sensitivity_level: "basso",
      data_conflicts: [],
      exclusion_reasons: [],
      provider_cost_estimate_eur: 0,
      last_checked_at: now,
      created_at: now,
      updated_at: now,
    },
    presentation: {
      title: "Capannone con uffici da riposizionare",
      territory: "Padova Ovest - Limena",
      microzone: "Limena",
      property_type: "commerciale",
      estimated_value: 1650000,
      commission_potential: 49500,
      commercial_reason:
        "L'immobile merita un piano dedicato per valorizzare metratura, posizione e tempi di vendita.",
      next_action: "Costruisci dossier industriale e script di contatto",
      dossier_status: "pronto",
    },
    ownerRange: { min: 1550000, max: 1750000 },
    zoneSummary:
      "Polo logistico-produttivo con domanda stabile da operatori locali; finestra utile per riposizionamento mirato.",
  },
];

function buildPayload(includeOwner: boolean): Array<OpportunityAgency & { owner_dossier?: ReturnType<typeof toOwnerDossier> }> {
  return INTERNAL.map(({ internal, presentation, ownerRange, zoneSummary }) => {
    const agency = toAgencyView(internal, presentation);
    assertAgencySafe(agency as unknown as Record<string, unknown>);
    if (!includeOwner) return agency;
    return { ...agency, owner_dossier: toOwnerDossier(agency, ownerRange, zoneSummary) };
  });
}

serve((req) => {
  const origin = req.headers.get("origin");
  const cors = corsFor(origin);

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, cors);

  const url = new URL(req.url);
  const includeOwner = url.searchParams.get("include") === "owner_dossier";

  try {
    const payload = buildPayload(includeOwner);
    return json(payload, 200, cors);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal_error";
    return json({ error: { code: "agency_view_violation", message: msg } }, 500, cors);
  }
});
