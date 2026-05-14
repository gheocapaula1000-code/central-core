// publish-microzona-dossier — Step 5 workflow pilota Arcella
// Edge function di publishing in DRY-RUN.
// - Recupera l'ultimo snapshot valido di Arcella da `microzona_dossier`
// - Costruisce l'envelope standard del Core (ok/data/warnings/debug_id)
// - NON invia nulla alla PWA, NON cambia stato in DB, NON chiama servizi esterni.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AI_CORE_SECRET = Deno.env.get("AI_CORE_SECRET") ?? "";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-core-secret, x-source-app",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "X-Core-Function": "publish-microzona-dossier",
  "X-Core-Route": "dry-run",
  "X-Core-Contract": "v1",
};

const ALLOWED_LIVELLI = new Set(["certo", "probabile", "da_testare"]);
const ALLOWED_STATI = new Set(["approvata_interna", "pubblicabile"]);

function timingSafeEq(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function envelope(
  ok: boolean,
  data: unknown,
  warnings: string[],
  debugId: string,
  error?: { code: string; message: string },
  status = 200,
) {
  const body: Record<string, unknown> = { ok, data, warnings, debug_id: debugId };
  if (error) body.error = error;
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface DossierRow {
  id: string;
  microzona_id: string;
  versione: string;
  stato: string;
  servizi_prossimita: unknown;
  segnali_territoriali: unknown;
  opportunita_candidate: unknown;
  asset_osservati: unknown;
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

function buildRiepilogo(blocchi: Record<string, Array<Record<string, unknown>>>) {
  const ripartizione = { certo: 0, probabile: 0, da_testare: 0 };
  let totale = 0;
  for (const items of Object.values(blocchi)) {
    for (const item of items) {
      const livello = typeof item.livello === "string" ? item.livello : "";
      if (ALLOWED_LIVELLI.has(livello)) {
        ripartizione[livello as keyof typeof ripartizione] += 1;
        totale += 1;
      }
    }
  }
  return { totale_elementi: totale, ripartizione };
}

Deno.serve(async (req) => {
  const debugId = crypto.randomUUID();

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Auth: o l'header segmentato del Core, o la sessione utente (gestita a monte da Lovable Cloud).
  const provided = req.headers.get("x-core-secret") ?? "";
  const hasSecret = AI_CORE_SECRET && timingSafeEq(provided, AI_CORE_SECRET);
  const hasJwt = !!req.headers.get("authorization");
  if (!hasSecret && !hasJwt) {
    return envelope(false, null, [], debugId, { code: "unauthorized", message: "auth required" }, 401);
  }

  // Input: microzona via query o body. In questo step accettiamo solo "arcella".
  let microzonaId = "arcella";
  let snapshotId: string | undefined;
  try {
    const url = new URL(req.url);
    microzonaId = (url.searchParams.get("microzona_id") ?? "arcella").toLowerCase();
    snapshotId = url.searchParams.get("snapshot_id") ?? undefined;
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (typeof body?.microzona_id === "string") microzonaId = body.microzona_id.toLowerCase();
      if (typeof body?.snapshot_id === "string") snapshotId = body.snapshot_id;
    }
  } catch {
    /* ignore — defaults */
  }

  if (microzonaId !== "arcella") {
    return envelope(
      false,
      null,
      [],
      debugId,
      { code: "scope_violation", message: "in questo step è supportata solo la microzona arcella" },
      400,
    );
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Recupero snapshot: per id se fornito, altrimenti l'ultimo per arcella.
  let query = supabase
    .from("microzona_dossier")
    .select(
      "id, microzona_id, versione, stato, servizi_prossimita, segnali_territoriali, opportunita_candidate, asset_osservati",
    )
    .eq("microzona_id", "arcella")
    .order("versione", { ascending: false })
    .limit(1);

  if (snapshotId) {
    query = supabase
      .from("microzona_dossier")
      .select(
        "id, microzona_id, versione, stato, servizi_prossimita, segnali_territoriali, opportunita_candidate, asset_osservati",
      )
      .eq("id", snapshotId)
      .eq("microzona_id", "arcella")
      .limit(1);
  }

  const { data: rows, error } = await query;

  if (error) {
    return envelope(
      false,
      null,
      [],
      debugId,
      { code: "db_error", message: "lettura snapshot non riuscita" },
      500,
    );
  }

  const row = (rows?.[0] as DossierRow | undefined) ?? null;
  if (!row) {
    return envelope(
      false,
      null,
      [],
      debugId,
      { code: "no_snapshot", message: "nessuno snapshot valido disponibile per arcella" },
      404,
    );
  }

  const warnings: string[] = [];

  // Stato: in dry-run accettiamo approvata_interna o pubblicabile.
  // Non promuoviamo a "pubblicata" e non scriviamo nulla sul DB.
  let stato = row.stato;
  if (!ALLOWED_STATI.has(stato)) {
    warnings.push(`stato "${stato}" non pubblicabile in dry-run, fallback a "approvata_interna"`);
    stato = "approvata_interna";
  }

  const blocchi = {
    servizi_prossimita: asArray(row.servizi_prossimita),
    segnali_territoriali: asArray(row.segnali_territoriali),
    opportunita_candidate: asArray(row.opportunita_candidate),
    asset_osservati: asArray(row.asset_osservati),
  };

  // Validazioni leggere coerenti col workflow interno.
  for (const [key, items] of Object.entries(blocchi)) {
    if (items.length === 0) warnings.push(`blocco "${key}" vuoto`);
    items.forEach((it, idx) => {
      const livello = typeof it.livello === "string" ? it.livello : "";
      if (!ALLOWED_LIVELLI.has(livello)) {
        warnings.push(`${key}[${idx}] livello mancante o non ammesso`);
      }
    });
  }

  const riepilogo = buildRiepilogo(blocchi);
  if (riepilogo.totale_elementi > 0) {
    const ratio = riepilogo.ripartizione.da_testare / riepilogo.totale_elementi;
    if (ratio > 0.5) {
      warnings.push(
        `rapporto da_testare elevato (${(ratio * 100).toFixed(0)}%): consolidare i livelli`,
      );
    }
  }

  const data = {
    microzona_id: "arcella",
    versione: row.versione,
    stato,
    blocchi,
    riepilogo,
  };

  return envelope(true, data, warnings, debugId);
});
