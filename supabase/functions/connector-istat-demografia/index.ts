// ═══════════════════════════════════════════════════════════════
// connector-istat-demografia — segnale demografico reale per comune
// Sorgente: tabella istat_comuni già popolata nel Core (dati ISTAT reali).
// Per ogni comune Padova + cintura genera 1 segnale "pressione demografica"
// quando l'indice di vecchiaia o la % over 65 sono significativi.
// Nessun dato inventato: ricalcola da righe esistenti.
// ═══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isJobSecretAuthorized } from "../_shared/http.ts";
import { writeSourceRegistryStatus } from "../_shared/sourceRegistryStatus.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

const COMUNI = [
  "Padova", "Albignasego", "Cadoneghe", "Rubano", "Selvazzano Dentro",
  "Ponte San Nicolò", "Noventa Padovana", "Vigodarzere", "Limena", "Abano Terme",
  "Saonara",
];

// Centroidi approssimati per geocoding di comune (lat,lon) — solo per posizionamento mappa.
// Sono coordinate ufficiali dei municipi/centri comunali Veneto.
const CENTROIDS: Record<string, [number, number]> = {
  "Padova": [45.4064, 11.8768],
  "Albignasego": [45.3490, 11.8633],
  "Cadoneghe": [45.4544, 11.9219],
  "Rubano": [45.4150, 11.7833],
  "Selvazzano Dentro": [45.3917, 11.7833],
  "Ponte San Nicolò": [45.3789, 11.9011],
  "Noventa Padovana": [45.4083, 11.9389],
  "Vigodarzere": [45.4644, 11.8761],
  "Limena": [45.4861, 11.8758],
  "Abano Terme": [45.3597, 11.7903],
  "Saonara": [45.3956, 11.9750],
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: { code: "method_not_allowed" } });

  const svc = createClient(SUPABASE_URL, SERVICE_KEY);
  const jobSecretOk = isJobSecretAuthorized(req, JOB_SECRET);

  if (!jobSecretOk) {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json(401, { error: { code: "unauthorized" } });

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: { code: "unauthorized" } });

    const { data: isAdmin } = await svc.rpc("has_role", { _user_id: userData.user.id, _role: "admin" });
    if (!isAdmin) return json(403, { error: { code: "forbidden", message: "admin required" } });
  }
  if (!JOB_SECRET) return json(500, { error: { code: "misconfigured" } });

  const { data: rows, error: qErr } = await svc
    .from("istat_comuni")
    .select("comune,popolazione,percentuale_over65,indice_vecchiaia,codice_istat")
    .in("comune", COMUNI);

  if (qErr) {
    await writeSourceRegistryStatus(svc, "F2", {
      ok: false,
      error: `demografia_query:${qErr.message}`.slice(0, 500),
      writeRecordCount: false,
    });
    return json(500, { error: { code: "query_failed", message: qErr.message } });
  }

  const items = (rows ?? [])
    .filter((r: any) => r.indice_vecchiaia != null || r.percentuale_over65 != null)
    .map((r: any) => {
      const iv = r.indice_vecchiaia != null ? Number(r.indice_vecchiaia) : null;
      const over65 = r.percentuale_over65 != null ? Number(r.percentuale_over65) : null;
      const centroid = CENTROIDS[r.comune];
      const tags = ["segnale_demografico", "ricambio-generazionale"];
      const bits: string[] = [];
      if (iv != null) bits.push(`indice vecchiaia ${iv.toFixed(0)}`);
      if (over65 != null) bits.push(`over 65 ${over65.toFixed(1)}%`);
      const title = `Pressione demografica a ${r.comune}`;
      const summary = bits.join(", ");
      return {
        source_name: "istat:demografia",
        source_url: "https://www.istat.it/it/popolazione-e-famiglie",
        municipality: r.comune,
        microzone: null,
        title,
        address_text: null,
        property_type: "segnale demografico",
        ask_price: null,
        surface_mq: null,
        latitude: centroid?.[0] ?? null,
        longitude: centroid?.[1] ?? null,
        fetched_at: new Date().toISOString(),
        category: "segnale_demografico",
        tags,
        external_ref: `istat:${r.codice_istat ?? r.comune}`,
        raw_payload: { source: "istat_comuni", summary, indice_vecchiaia: iv, percentuale_over65: over65, popolazione: r.popolazione },
      };
    });

  if (items.length === 0) {
    await writeSourceRegistryStatus(svc, "F2", {
      ok: true,
      error: null,
      writeRecordCount: false,
    });
    return json(200, { ok: true, records_processed: 0, data: { read: 0, normalized: 0, records_processed: 0, note: "no istat rows for comuni" } });
  }

  const res = await fetch(`${SUPABASE_URL}/functions/v1/ingest-opportunity`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "apikey": SERVICE_KEY,
      "x-job-secret": JOB_SECRET,
    },
    body: JSON.stringify(items),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    await writeSourceRegistryStatus(svc, "F2", {
      ok: false,
      error: `demografia_ingest:${msg}`.slice(0, 500),
      writeRecordCount: false,
    });
    return json(502, { error: { code: "ingest_failed", message: msg } });
  }

  let normalized = 0;
  const errors: string[] = [];
  for (const r of (body?.results ?? [])) {
    if (r.normalized_id) normalized++;
    if (r.error) errors.push(r.error);
  }

  await writeSourceRegistryStatus(svc, "F2", {
    ok: true,
    error: null,
    writeRecordCount: false,
  });

  return json(200, { ok: true, records_processed: normalized, data: { read: items.length, normalized, records_processed: normalized, errors: errors.slice(0, 5) } });
});
