// ═══════════════════════════════════════════════════════════════
// fetch-albo-pretorio
// Scraper profondo degli Albi Pretori comunali: cerca delibere di
// cambio destinazione d'uso, pratiche edilizie pesanti, successioni
// pubblicate. Output: insert in normalized_opportunities con
// tag 'albo_pretorio' che innesca il trigger off-market_puro.
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

// Albi Pretori target — fonti pubbliche istituzionali (Veneto pilota)
const ALBI: Array<{ comune: string; cap: string; url: string }> = [
  { comune: "Padova", cap: "35100", url: "https://albo.comune.padova.it/" },
  { comune: "Albignasego", cap: "35020", url: "https://albo.comune.albignasego.pd.it/" },
  { comune: "Selvazzano Dentro", cap: "35030", url: "https://albo.selvazzanodentro.gov.it/" },
  { comune: "Abano Terme", cap: "35031", url: "https://albo.abanoterme.gov.it/" },
];

const PROMPT_EXTRACT =
  "Estrai SOLO atti pubblicati che riguardano: cambi di destinazione d'uso, permessi a costruire, SCIA/CILA pesanti, dichiarazioni di successione, pubblicazione testamenti, esecuzioni immobiliari, vendite/aste di immobili. Per ogni atto trova: titolo, numero atto, data pubblicazione, oggetto, indirizzo (se presente), tipologia (cambio_destinazione|edilizia_pesante|successione|esecuzione), link diretto. NIENTE dati personali (nomi/cognomi). Se la pagina non contiene nulla di immobiliare, restituisci atti:[].";

interface Atto {
  titolo?: string;
  numero?: string;
  data?: string;
  oggetto?: string;
  indirizzo?: string;
  tipologia?: string;
  link?: string;
}

async function firecrawlExtract(url: string): Promise<Atto[]> {
  if (!FIRECRAWL) return [];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 50_000);
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
          prompt: PROMPT_EXTRACT,
          schema: {
            type: "object",
            properties: {
              atti: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    titolo: { type: "string" },
                    numero: { type: "string" },
                    data: { type: "string" },
                    oggetto: { type: "string" },
                    indirizzo: { type: "string" },
                    tipologia: { type: "string" },
                    link: { type: "string" },
                  },
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
    const atti = data?.data?.extract?.atti ?? data?.extract?.atti ?? [];
    return Array.isArray(atti) ? atti : [];
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

function isRelevant(a: Atto): boolean {
  const blob = `${a.titolo ?? ""} ${a.oggetto ?? ""} ${a.tipologia ?? ""}`.toLowerCase();
  return /(destinazione|permesso|scia|cila|costruire|succession|testament|esecuzion|asta|vendita)/.test(
    blob,
  );
}

function authorized(req: Request): boolean {
  if (!JOB_SECRET) return true;
  const h = req.headers.get("x-job-secret") ?? "";
  return h === JOB_SECRET;
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
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const out: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];

    for (const a of ALBI) {
      const atti = await firecrawlExtract(a.url);
      const relevant = atti.filter(isRelevant).slice(0, 25);
      if (!relevant.length) {
        warnings.push(`Nessun atto immobiliare rilevante per ${a.comune}`);
        continue;
      }
      for (const r of relevant) {
        const tipologia = (r.tipologia ?? "").toLowerCase();
        const isSuccess = /succession|testament/.test(tipologia + " " + (r.oggetto ?? ""));
        const link = r.link?.startsWith("http")
          ? r.link
          : `${new URL(a.url).origin}${r.link?.startsWith("/") ? "" : "/"}${r.link ?? ""}`;

        out.push({
          source_name: "Albo Pretorio " + a.comune,
          source_url: link.slice(0, 400),
          municipality: a.comune,
          cap: a.cap,
          title: (r.titolo ?? r.oggetto ?? "Atto albo pretorio").slice(0, 200),
          address_text: (r.indirizzo ?? "").slice(0, 200) || null,
          category: isSuccess ? "successione" : "albo_pretorio",
          tags: ["albo_pretorio", isSuccess ? "successione" : tipologia || "edilizia"],
          external_ref: (r.numero ?? r.data ?? r.titolo ?? "").slice(0, 120),
          fetched_at: new Date().toISOString(),
          data_rilevamento: new Date().toISOString(),
          raw_payload: r as Record<string, unknown>,
        });
      }
    }

    if (out.length === 0) {
      return new Response(
        JSON.stringify({ data: [], warnings, error: null }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data, error } = await supabase
      .from("normalized_opportunities")
      .insert(out)
      .select("id,status,quality_bucket,municipality");

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
