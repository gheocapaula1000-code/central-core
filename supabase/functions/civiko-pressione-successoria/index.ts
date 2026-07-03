// civiko-pressione-successoria
// Endpoint pubblico white-label: espone la pressione successoria per CAP
// come score sintetico + label (bassa/media/alta), senza mai esporre
// conteggi grezzi di necrologi o fattori interni del modello.
//
// Query params:
//   cap?      es. 35121 (filtra un singolo CAP)
//   province? default PD

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  assertAggregateBucket,
  AGGREGATE_MIN_BUCKET_COUNT,
} from "../_shared/aggregateBucketGuard.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function scoreToLabel(score: number, dbLabel?: string | null): "bassa" | "media" | "alta" {
  const l = (dbLabel ?? "").toLowerCase();
  if (l === "bassa" || l === "media" || l === "alta") return l;
  if (score >= 60) return "alta";
  if (score >= 35) return "media";
  return "bassa";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const capRaw = url.searchParams.get("cap");
  const provinceRaw = (url.searchParams.get("province") ?? "PD").toUpperCase();
  const WINDOW_DAYS = 90;

  const cap = capRaw && /^\d{5}$/.test(capRaw) ? capRaw : null;
  const province = /^[A-Z]{2}$/.test(provinceRaw) ? provinceRaw : "PD";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    let q = supabase
      .from("succession_heatmap_cap")
      .select("cap, province, municipality_main, probability_score, probability_label, computed_at")
      .eq("province", province)
      .not("probability_score", "is", null)
      .order("probability_score", { ascending: false })
      .limit(500);

    if (cap) q = q.eq("cap", cap);

    const { data, error } = await q;
    if (error) throw error;

    const warnings: string[] = [];
    const items: Array<Record<string, unknown>> = [];

    for (const r of data ?? []) {
      const score = Number(r.probability_score ?? 0);
      const label = scoreToLabel(score, r.probability_label);
      const item = {
        cap: r.cap,
        municipality: r.municipality_main ?? null,
        province: r.province ?? province,
        score: Math.round(score * 10) / 10,
        label,
        computed_at: r.computed_at,
        window_days: WINDOW_DAYS,
      };

      // Compliance guard: valida che il payload sia aggregato PII-free.
      // bucket_count viene passato come soglia k-anonimity (>=3) perché la
      // heatmap è già un aggregato per CAP costruito su bucket k-safe.
      const check = assertAggregateBucket({
        area_type: "cap",
        area_code: item.cap,
        bucket_count: AGGREGATE_MIN_BUCKET_COUNT,
        window_days: WINDOW_DAYS,
        municipality: item.municipality ?? undefined,
        label: item.label,
      });
      if (!check.allowed) {
        warnings.push(`dropped:${item.cap}:${check.violations.join("|")}`);
        continue;
      }

      items.push(item);
    }

    return json({
      ok: true,
      updated_at: new Date().toISOString(),
      window_days: WINDOW_DAYS,
      province,
      total: items.length,
      items,
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (e) {
    return json({
      ok: false,
      error: "internal_error",
      message: (e as Error).message,
      items: [],
    }, 500);
  }
});
