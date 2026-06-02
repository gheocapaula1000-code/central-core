// ═══════════════════════════════════════════════════════════════
// fetch-aste-nascoste
// Estrae le pre-aste PVP focalizzandosi sulla DATA DI DEPOSITO
// della perizia (non sulla data dell'asta): in quella finestra
// l'immobile è già destinato all'asta ma ancora invisibile al
// mercato. Tagga il record come 'pre_asta' e 'aste_nascoste'
// così il trigger lo classifica off-market_puro (fonte istituzionale).
// ═══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-job-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FIRECRAWL = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

// Default: Padova e provincia. Estendibile via body { localita, raggio, cap }.
const DEFAULT_LOCATIONS = [
  { localita: "Padova", cap: "35100", lat: 45.4064, lng: 11.8768 },
];

interface Body {
  localita?: string;
  cap?: string;
  lat?: number;
  lng?: number;
  raggio?: number;
  giorni_finestra_deposito?: number; // default 90
}

interface AstaScraped {
  tipo?: string;
  indirizzo?: string;
  prezzoBase?: string;
  dataDeposito?: string; // perizia / pubblicazione ordinanza
  dataVendita?: string;
  superficie?: string;
  numeroProcedura?: string;
  link?: string;
}

function parseNum(s?: string | null): number | null {
  if (!s) return null;
  const n = Number(String(s).replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function authorized(req: Request): boolean {
  if (!JOB_SECRET) return true;
  return (req.headers.get("x-job-secret") ?? "") === JOB_SECRET;
}

async function scrapePreAste(
  loc: { localita: string; lat: number; lng: number },
  raggio: number,
): Promise<AstaScraped[]> {
  if (!FIRECRAWL) return [];

  // PVP — filtro: solo IMMOBILI, ordinati per dataDeposito ASC (i più "freschi")
  const url =
    `https://pvp.giustizia.it/pvp/it/lista_annunci.wp?searchType=searchForm&page=0&size=25` +
    `&sortProperty=dataDeposito,asc&macro=IMMOBILI` +
    `&localita=${encodeURIComponent(loc.localita)}` +
    `&raggioAzione=${raggio}&coordIndirizzo=${loc.lat},${loc.lng}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45_000);

  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["extract"],
        onlyMainContent: true,
        extract: {
          prompt:
            "Estrai TUTTE le aste/pre-aste immobiliari della pagina. Per ognuna voglio: tipo immobile, indirizzo, prezzo base, data DEPOSITO perizia/ordinanza (NON la data dell'asta), data vendita, superficie in mq, numero procedura, link. La data di deposito è cruciale: se non c'è non includere il record.",
          schema: {
            type: "object",
            properties: {
              aste: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    tipo: { type: "string" },
                    indirizzo: { type: "string" },
                    prezzoBase: { type: "string" },
                    dataDeposito: { type: "string" },
                    dataVendita: { type: "string" },
                    superficie: { type: "string" },
                    numeroProcedura: { type: "string" },
                    link: { type: "string" },
                  },
                  required: ["link"],
                },
              },
            },
          },
        },
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const aste = data?.data?.extract?.aste ?? data?.extract?.aste ?? [];
    return Array.isArray(aste) ? aste : [];
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

function ageDays(dateStr?: string | null): number | null {
  if (!dateStr) return null;
  // accetta DD/MM/YYYY o ISO
  let d: Date | null = null;
  const m = String(dateStr).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) d = new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  else { const t = Date.parse(dateStr); if (!Number.isNaN(t)) d = new Date(t); }
  if (!d || Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!authorized(req)) {
    return new Response(JSON.stringify({ data: null, error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    let body: Body = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));

    const locations = body.localita
      ? [{
          localita: body.localita,
          cap: body.cap ?? "",
          lat: body.lat ?? 45.4064,
          lng: body.lng ?? 11.8768,
        }]
      : DEFAULT_LOCATIONS;
    const raggio = body.raggio ?? 15;
    const finestra = body.giorni_finestra_deposito ?? 90;

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const rows: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];

    for (const loc of locations) {
      const aste = await scrapePreAste(loc, raggio);
      if (!aste.length) { warnings.push(`Nessuna pre-asta per ${loc.localita}`); continue; }

      for (const a of aste) {
        const age = ageDays(a.dataDeposito);
        if (age == null || age > finestra) continue; // solo finestra fresca

        const link = a.link?.startsWith("http")
          ? a.link
          : `https://pvp.giustizia.it${a.link?.startsWith("/") ? "" : "/"}${a.link ?? ""}`;

        rows.push({
          source_name: "aste_nascoste PVP",
          source_url: link.slice(0, 400),
          municipality: loc.localita,
          cap: loc.cap || null,
          title: `Pre-asta: ${(a.tipo ?? "Immobile").slice(0, 120)}`,
          address_text: (a.indirizzo ?? "").slice(0, 200) || null,
          ask_price: parseNum(a.prezzoBase),
          surface_mq: parseNum(a.superficie),
          category: "pre_asta",
          tags: ["aste_nascoste", "pre_asta", "tribunale"],
          external_ref: (a.numeroProcedura ?? a.dataDeposito ?? "").slice(0, 120),
          fetched_at: new Date().toISOString(),
          data_rilevamento: new Date().toISOString(),
          raw_payload: { ...a, finestra_deposito_giorni: age } as Record<string, unknown>,
        });
      }
    }

    if (rows.length === 0) {
      return new Response(
        JSON.stringify({ data: [], warnings, error: null }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data, error } = await supabase
      .from("normalized_opportunities")
      .insert(rows)
      .select("id,status,quality_bucket,municipality,ask_price");

    if (error) {
      return new Response(
        JSON.stringify({ data: null, error: error.message, warnings }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        data,
        warnings,
        error: null,
        stats: {
          inserted: data?.length ?? 0,
          off_market_puro: data?.filter((d) => d.status === "off-market_puro").length ?? 0,
          bruciato: data?.filter((d) => d.status === "bruciato").length ?? 0,
          rumore: data?.filter((d) => d.quality_bucket === "rumore_di_fondo").length ?? 0,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ data: null, error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
