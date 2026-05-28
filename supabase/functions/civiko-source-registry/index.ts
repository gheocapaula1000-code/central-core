// civiko-source-registry — admin-only registry + CSV importer per fonti dati Padova.
// Routes:
//   GET  /sources                       → lista registry
//   POST /import/elderly-population     → F4
//   POST /import/apr4-mobility          → F3 + F20
//   POST /import/market-benchmark       → F12
//   POST /import/sue-permits            → F18
//   POST /import/separations            → F22
//
// Auth: Bearer JWT utente + has_role('admin') OR bootstrap email.
// Body: { csv: "<raw csv>", source_url?: string }
// CSV: prima riga = header. Vedi docs/civiko-padova-data-sources.md per gli schemi.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { parseCsv, toIntOrNull, toNumberOrNull, type CsvRow } from "../_shared/csvImport.ts";
import { assertAggregateOnly } from "../_shared/compliance.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

function getOwnerEmails(): string[] {
  const raw = Deno.env.get("CORE_ADMIN_BOOTSTRAP_EMAILS") ?? "";
  return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function svc() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

async function requireAdmin(req: Request): Promise<{ userId: string; email: string } | Response> {
  const auth = req.headers.get("Authorization");
  if (!auth) return json({ ok: false, error: { code: "UNAUTHORIZED", message: "Missing Authorization" } }, 401);
  const supabase = svc();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error } = await supabase.auth.getUser(token);
  if (error || !userData.user) {
    return json({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid token" } }, 401);
  }
  const email = (userData.user.email ?? "").toLowerCase();
  const isOwner = getOwnerEmails().includes(email);
  let isAdmin = isOwner;
  if (!isAdmin) {
    const { data: role } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("role", "admin")
      .maybeSingle();
    isAdmin = !!role;
  }
  if (!isAdmin) return json({ ok: false, error: { code: "FORBIDDEN", message: "Admin only" } }, 403);
  return { userId: userData.user.id, email };
}

async function updateRegistry(sourceCode: string, ok: boolean, recordCount: number, error?: string) {
  const supabase = svc();
  const patch: Record<string, unknown> = {
    record_count: recordCount,
    implementation_status: ok ? "live" : "partial",
  };
  if (ok) patch.last_success_at = new Date().toISOString();
  if (error) patch.last_error = error.slice(0, 500);
  else if (ok) patch.last_error = null;
  await supabase.from("civiko_source_registry").update(patch).eq("source_code", sourceCode);
}

async function readBody(req: Request): Promise<{ csv?: string; source_url?: string; rows?: CsvRow[] }> {
  try {
    const j = await req.json();
    return { csv: j?.csv, source_url: j?.source_url, rows: j?.rows };
  } catch {
    return {};
  }
}

// ────────────────────────────────────────────────────────────
// F4 Elderly population
// CSV: year, area_name, area_code?, over_65_count?, over_75_count?, total_population?
// ────────────────────────────────────────────────────────────
async function importElderly(req: Request) {
  const body = await readBody(req);
  const rows = body.rows ?? (body.csv ? parseCsv(body.csv) : []);
  if (rows.length === 0) return json({ ok: false, error: { code: "EMPTY_INPUT", message: "csv or rows required" } }, 400);

  const sourceUrl = body.source_url ?? "https://www.padovanet.it/informazione/popolazione";
  const records = [];
  for (const r of rows) {
    assertAggregateOnly(r, "F4");
    const year = toIntOrNull(r.year ?? r.anno);
    const areaName = (r.area_name ?? r.area ?? r.quartiere ?? "").trim();
    if (!year || !areaName) continue;
    records.push({
      year,
      area_name: areaName,
      area_code: r.area_code ?? r.codice ?? null,
      over_65_count: toIntOrNull(r.over_65_count ?? r.over_65),
      over_75_count: toIntOrNull(r.over_75_count ?? r.over_75),
      total_population: toIntOrNull(r.total_population ?? r.popolazione_totale ?? r.totale),
      source_url: sourceUrl,
      imported_at: new Date().toISOString(),
    });
  }
  if (records.length === 0) {
    await updateRegistry("F4", false, 0, "No valid rows after normalization");
    return json({ ok: false, error: { code: "NO_VALID_ROWS", message: "All rows rejected" } }, 400);
  }
  const supabase = svc();
  const { error } = await supabase
    .from("padova_elderly_population")
    .upsert(records, { onConflict: "year,area_name" });
  if (error) {
    await updateRegistry("F4", false, 0, error.message);
    return json({ ok: false, error: { code: "DB_ERROR", message: error.message } }, 500);
  }
  const { count } = await supabase.from("padova_elderly_population").select("*", { count: "exact", head: true });
  await updateRegistry("F4", true, count ?? records.length);
  return json({ ok: true, data: { imported: records.length, total: count ?? null } });
}

// ────────────────────────────────────────────────────────────
// F3/F20 APR4 mobility
// CSV: year, comune, comune_istat, iscritti, cancellati, saldo_migratorio?, transfer_rate?
// ────────────────────────────────────────────────────────────
async function importApr4(req: Request) {
  const body = await readBody(req);
  const rows = body.rows ?? (body.csv ? parseCsv(body.csv) : []);
  if (rows.length === 0) return json({ ok: false, error: { code: "EMPTY_INPUT", message: "csv or rows required" } }, 400);
  const sourceUrl = body.source_url ?? "https://demo.istat.it/";

  const records = [];
  for (const r of rows) {
    assertAggregateOnly(r, "F3/F20");
    const year = toIntOrNull(r.year ?? r.anno);
    const comune = (r.comune ?? "").trim();
    const istat = (r.comune_istat ?? r.istat ?? "").trim();
    if (!year || !comune || !istat) continue;
    const iscritti = toIntOrNull(r.iscritti);
    const cancellati = toIntOrNull(r.cancellati);
    const saldo = toIntOrNull(r.saldo_migratorio) ?? (iscritti != null && cancellati != null ? iscritti - cancellati : null);
    records.push({
      year,
      comune,
      comune_istat: istat,
      iscritti,
      cancellati,
      saldo_migratorio: saldo,
      transfer_rate: toNumberOrNull(r.transfer_rate),
      source_url: sourceUrl,
      imported_at: new Date().toISOString(),
    });
  }
  if (records.length === 0) {
    await updateRegistry("F3", false, 0, "No valid rows");
    return json({ ok: false, error: { code: "NO_VALID_ROWS", message: "All rows rejected" } }, 400);
  }
  const supabase = svc();
  const { error } = await supabase
    .from("istat_apr4_mobility")
    .upsert(records, { onConflict: "year,comune_istat" });
  if (error) {
    await updateRegistry("F3", false, 0, error.message);
    await updateRegistry("F20", false, 0, error.message);
    return json({ ok: false, error: { code: "DB_ERROR", message: error.message } }, 500);
  }
  const { count } = await supabase.from("istat_apr4_mobility").select("*", { count: "exact", head: true });
  await updateRegistry("F3", true, count ?? records.length);
  await updateRegistry("F20", true, count ?? records.length);
  return json({ ok: true, data: { imported: records.length, total: count ?? null } });
}

// ────────────────────────────────────────────────────────────
// F12 Market benchmark
// CSV: period, area_name, min_price_eur_mq?, max_price_eur_mq?, avg_price_eur_mq?, rent_eur_mq_month?, source_name
// ────────────────────────────────────────────────────────────
async function importMarketBenchmark(req: Request) {
  const body = await readBody(req);
  const rows = body.rows ?? (body.csv ? parseCsv(body.csv) : []);
  if (rows.length === 0) return json({ ok: false, error: { code: "EMPTY_INPUT", message: "csv or rows required" } }, 400);

  const records = [];
  for (const r of rows) {
    const period = (r.period ?? r.periodo ?? "").trim();
    const areaName = (r.area_name ?? r.area ?? "").trim();
    const sourceName = (r.source_name ?? "").trim();
    if (!period || !areaName || !sourceName) continue;
    records.push({
      period,
      area_name: areaName,
      min_price_eur_mq: toNumberOrNull(r.min_price_eur_mq),
      max_price_eur_mq: toNumberOrNull(r.max_price_eur_mq),
      avg_price_eur_mq: toNumberOrNull(r.avg_price_eur_mq),
      rent_eur_mq_month: toNumberOrNull(r.rent_eur_mq_month),
      source_name: sourceName,
      source_url: r.source_url ?? body.source_url ?? null,
      imported_at: new Date().toISOString(),
    });
  }
  if (records.length === 0) {
    await updateRegistry("F12", false, 0, "No valid rows");
    return json({ ok: false, error: { code: "NO_VALID_ROWS", message: "All rows rejected" } }, 400);
  }
  const supabase = svc();
  const { error } = await supabase
    .from("market_benchmark_padova")
    .upsert(records, { onConflict: "period,area_name,source_name" });
  if (error) {
    await updateRegistry("F12", false, 0, error.message);
    return json({ ok: false, error: { code: "DB_ERROR", message: error.message } }, 500);
  }
  const { count } = await supabase.from("market_benchmark_padova").select("*", { count: "exact", head: true });
  await updateRegistry("F12", true, count ?? records.length);
  return json({ ok: true, data: { imported: records.length, total: count ?? null } });
}

// ────────────────────────────────────────────────────────────
// F18 SUE permits
// CSV: area_name?, address_public?, practice_type, practice_date, status, compliance_verified
// ────────────────────────────────────────────────────────────
async function importSue(req: Request) {
  const body = await readBody(req);
  const rows = body.rows ?? (body.csv ? parseCsv(body.csv) : []);
  if (rows.length === 0) return json({ ok: false, error: { code: "EMPTY_INPUT", message: "csv or rows required" } }, 400);

  const records = [];
  for (const r of rows) {
    const verified = String(r.compliance_verified ?? "").toLowerCase() === "true";
    if (!verified) continue; // compliance guard: solo righe esplicitamente marcate
    records.push({
      area_name: r.area_name ?? null,
      address_public: r.address_public ?? null,
      practice_type: r.practice_type ?? null,
      practice_date: r.practice_date ?? null,
      status: r.status ?? null,
      source_url: r.source_url ?? body.source_url ?? null,
      compliance_verified: true,
      imported_at: new Date().toISOString(),
    });
  }
  if (records.length === 0) {
    await updateRegistry("F18", false, 0, "No rows with compliance_verified=true");
    return json({ ok: false, error: { code: "COMPLIANCE_NOT_VERIFIED", message: "Each row must include compliance_verified=true" } }, 400);
  }
  const supabase = svc();
  const { error } = await supabase.from("sue_padova_permits").insert(records);
  if (error) {
    await updateRegistry("F18", false, 0, error.message);
    return json({ ok: false, error: { code: "DB_ERROR", message: error.message } }, 500);
  }
  const { count } = await supabase.from("sue_padova_permits").select("*", { count: "exact", head: true });
  await updateRegistry("F18", true, count ?? records.length);
  return json({ ok: true, data: { imported: records.length, total: count ?? null } });
}

// ────────────────────────────────────────────────────────────
// F22 Separations (aggregate only)
// CSV: year, comune, comune_istat, separations_count?, divorces_count?, marriages_count?
// ────────────────────────────────────────────────────────────
async function importSeparations(req: Request) {
  const body = await readBody(req);
  const rows = body.rows ?? (body.csv ? parseCsv(body.csv) : []);
  if (rows.length === 0) return json({ ok: false, error: { code: "EMPTY_INPUT", message: "csv or rows required" } }, 400);
  const sourceUrl = body.source_url ?? "https://www.istat.it/it/separazioni-e-divorzi";

  const records = [];
  for (const r of rows) {
    assertAggregateOnly(r, "F22");
    const year = toIntOrNull(r.year ?? r.anno);
    const comune = (r.comune ?? "").trim();
    const istat = (r.comune_istat ?? r.istat ?? "").trim();
    if (!year || !comune || !istat) continue;
    records.push({
      year,
      comune,
      comune_istat: istat,
      separations_count: toIntOrNull(r.separations_count),
      divorces_count: toIntOrNull(r.divorces_count),
      marriages_count: toIntOrNull(r.marriages_count),
      separation_rate: toNumberOrNull(r.separation_rate),
      divorce_rate: toNumberOrNull(r.divorce_rate),
      source_url: sourceUrl,
      imported_at: new Date().toISOString(),
    });
  }
  if (records.length === 0) {
    await updateRegistry("F22", false, 0, "No valid rows");
    return json({ ok: false, error: { code: "NO_VALID_ROWS", message: "All rows rejected" } }, 400);
  }
  const supabase = svc();
  const { error } = await supabase
    .from("istat_separations_padova")
    .upsert(records, { onConflict: "year,comune_istat" });
  if (error) {
    await updateRegistry("F22", false, 0, error.message);
    return json({ ok: false, error: { code: "DB_ERROR", message: error.message } }, 500);
  }
  const { count } = await supabase.from("istat_separations_padova").select("*", { count: "exact", head: true });
  await updateRegistry("F22", true, count ?? records.length);
  return json({ ok: true, data: { imported: records.length, total: count ?? null } });
}

// ────────────────────────────────────────────────────────────
// F19 Obituaries aggregate-only (privacy-safe).
// CSV/rows: area_type (cap|microzone|area), area_code, window_start (YYYY-MM-DD),
//           window_end (YYYY-MM-DD), bucket_count
// Hard rules enforced server-side:
//   - assertAggregateOnly: rejects any person-level field
//   - k-anonymity: bucket_count >= 3 (smaller buckets are silently suppressed)
//   - window_days >= 30 (default 90)
//   - No names, addresses, urls-to-records, no link to property/owner
// ────────────────────────────────────────────────────────────
export const F19_K_ANONYMITY_MIN = 3;
export const F19_DEFAULT_WINDOW_DAYS = 90;

async function importObituariesAggregate(req: Request) {
  const body = await readBody(req);
  const rows = body.rows ?? (body.csv ? parseCsv(body.csv) : []);
  if (rows.length === 0) return json({ ok: false, error: { code: "EMPTY_INPUT", message: "csv or rows required" } }, 400);
  const sourceUrl = body.source_url ?? null;

  const records: Array<Record<string, unknown>> = [];
  let suppressed = 0;
  for (const r of rows) {
    // Reject any person-level field outright (compliance guard).
    assertAggregateOnly(r, "F19");
    const areaType = String(r.area_type ?? "").trim().toLowerCase();
    const areaCode = String(r.area_code ?? "").trim();
    const windowStart = String(r.window_start ?? "").trim();
    const windowEnd = String(r.window_end ?? "").trim();
    const bucketCount = toIntOrNull(r.bucket_count);
    if (!["cap", "microzone", "area"].includes(areaType)) continue;
    if (!areaCode || !windowStart || !windowEnd || bucketCount == null) continue;
    // K-anonymity: suppress buckets under threshold. Never persist them.
    if (bucketCount < F19_K_ANONYMITY_MIN) { suppressed++; continue; }
    const days = Math.max(
      30,
      Math.round((Date.parse(windowEnd) - Date.parse(windowStart)) / 86_400_000) || F19_DEFAULT_WINDOW_DAYS,
    );
    records.push({
      area_type: areaType,
      area_code: areaCode,
      window_start: windowStart,
      window_end: windowEnd,
      window_days: days,
      bucket_count: bucketCount,
      source_url: sourceUrl,
      imported_at: new Date().toISOString(),
    });
  }
  if (records.length === 0) {
    await updateRegistry("F19", false, 0, `No valid aggregate rows (suppressed=${suppressed} under k=${F19_K_ANONYMITY_MIN})`);
    return json({
      ok: false,
      error: { code: "NO_VALID_ROWS", message: "All rows rejected or suppressed by k-anonymity threshold" },
      data: { suppressed, k_anonymity_min: F19_K_ANONYMITY_MIN },
    }, 400);
  }
  const supabase = svc();
  const { error } = await supabase
    .from("obituaries_aggregate_padova")
    .upsert(records, { onConflict: "area_type,area_code,window_start,window_end" });
  if (error) {
    await updateRegistry("F19", false, 0, error.message);
    return json({ ok: false, error: { code: "DB_ERROR", message: error.message } }, 500);
  }
  const { count } = await supabase.from("obituaries_aggregate_padova").select("*", { count: "exact", head: true });
  await updateRegistry("F19", true, count ?? records.length);
  return json({
    ok: true,
    data: {
      imported: records.length,
      suppressed,
      k_anonymity_min: F19_K_ANONYMITY_MIN,
      total: count ?? null,
      compliance: "aggregate_only",
    },
  });
}

// ────────────────────────────────────────────────────────────
// GET /sources
// ────────────────────────────────────────────────────────────
async function listSources() {
  const supabase = svc();
  const { data, error } = await supabase
    .from("civiko_source_registry")
    .select("*")
    .order("source_code", { ascending: true });
  if (error) return json({ ok: false, error: { code: "DB_ERROR", message: error.message } }, 500);
  return json({ ok: true, data });
}

// ────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const guard = await requireAdmin(req);
    if (guard instanceof Response) return guard;

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/civiko-source-registry/, "").replace(/\/+$/, "") || "/sources";

    if (req.method === "GET" && (path === "" || path === "/sources")) return await listSources();
    if (req.method === "POST" && path === "/import/elderly-population") return await importElderly(req);
    if (req.method === "POST" && path === "/import/apr4-mobility") return await importApr4(req);
    if (req.method === "POST" && path === "/import/market-benchmark") return await importMarketBenchmark(req);
    if (req.method === "POST" && path === "/import/sue-permits") return await importSue(req);
    if (req.method === "POST" && path === "/import/separations") return await importSeparations(req);

    return json({ ok: false, error: { code: "NOT_FOUND", message: `Unknown route ${req.method} ${path}` } }, 404);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error("civiko-source-registry error:", msg);
    return json({ ok: false, error: { code: "INTERNAL_ERROR", message: msg } }, 500);
  }
});
