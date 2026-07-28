// civiko-zones-list — public listing delle 8 zone commerciali ufficiali
// con stato di occupazione e flag `pilot_reservable`.
//
// Contratto territoriale:
// - esattamente 8 slug ufficiali (nessuna tassonomia legacy a 10 zone);
// - `pilot_reservable = true` solo per `centro-storico`;
// - quartieri mostrati derivati dal contratto applicativo
//   (Stazione solo in centro-storico, Fiera solo in est-brenta);
// - fail-closed: se il DB non restituisce esattamente gli 8 slug ufficiali
//   la risposta è un errore territoriale esplicito.
//
// Privacy: NON espone trial_agency_id / occupied_agency_id.

import {
  CIVIKO_COMMERCIAL_ZONES,
  isCivikoCommercialZoneSlug,
  type CivikoCommercialZoneSlug,
} from "../_shared/civikoCommercialZoneContract.ts";
import { PADOVA_QUARTIERI_LABELS_BY_ZONE } from "../_shared/civikoCommercialZoneByQuartiere.ts";
import { PADOVA_PILOT_ALLOWED_ZONE_SLUG } from "../_shared/civikoTerritoryContractPadovaPilotV1.ts";

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

export const OFFICIAL_SLUGS: readonly CivikoCommercialZoneSlug[] =
  CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug);

export type ZoneRow = {
  slug: string;
  nome: string | null;
  tier: string | null;
  canone_mese_eur: number | null;
  provvigioni_anno_eur: number | null;
  contendibili_count: number | null;
  status: string | null;
  trial_reserved_until: string | null;
  occupied_since: string | null;
};

export type ZonesLoader = () => Promise<{ rows: ZoneRow[] | null; error: string | null }>;

function getEnv(key: string): string {
  const d = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno;
  if (d?.env) return d.env.get(key) ?? "";
  const p = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
  return p?.env?.[key] ?? "";
}

const defaultLoader: ZonesLoader = async () => {
  const { createServiceClient } = await import("../_shared/supabaseServiceClient.ts");
  const sb = createServiceClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const { data, error } = await sb
    .from("civiko_commercial_zones")
    .select(
      "slug,nome,tier,canone_mese_eur,provvigioni_anno_eur,contendibili_count,status,trial_reserved_until,occupied_since",
    )
    .order("canone_mese_eur", { ascending: false });
  return { rows: (data as ZoneRow[] | null) ?? null, error: error?.message ?? null };
};

export async function handleZonesList(
  req: Request,
  loader: ZonesLoader = defaultLoader,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const debug_id = crypto.randomUUID();

  try {
    const { rows, error } = await loader();
    if (error) {
      return json({ ok: false, error: { code: "DB_ERROR", message: error }, debug_id }, 500);
    }

    const bySlug = new Map<string, ZoneRow>();
    for (const r of rows ?? []) {
      if (r && typeof r.slug === "string") bySlug.set(r.slug, r);
    }

    // Fail-closed territoriale: servono esattamente gli 8 slug ufficiali.
    const missing = OFFICIAL_SLUGS.filter((s) => !bySlug.has(s));
    const unknown = [...bySlug.keys()].filter((s) => !isCivikoCommercialZoneSlug(s));
    if (missing.length > 0 || unknown.length > 0 || bySlug.size !== OFFICIAL_SLUGS.length) {
      return json(
        {
          ok: false,
          error: {
            code: "TERRITORY_CONTRACT_VIOLATION",
            message:
              "Il set di zone in database non corrisponde agli 8 slug ufficiali del contratto territoriale.",
            details: { expected: OFFICIAL_SLUGS.length, found: bySlug.size, missing, unknown },
          },
          debug_id,
        },
        500,
      );
    }

    const zones = CIVIKO_COMMERCIAL_ZONES.map((z) => {
      const r = bySlug.get(z.slug) as ZoneRow;
      return {
        slug: z.slug,
        nome: r.nome ?? z.nome,
        tier: r.tier,
        canone_mese_eur: r.canone_mese_eur,
        provvigioni_anno_eur: r.provvigioni_anno_eur,
        contendibili_count: r.contendibili_count,
        status: r.status,
        trial_reserved_until: r.trial_reserved_until,
        pilot_reservable: z.slug === PADOVA_PILOT_ALLOWED_ZONE_SLUG,
        quartieri_principali: PADOVA_QUARTIERI_LABELS_BY_ZONE[z.slug] ?? [],
      };
    });

    return json({ ok: true, data: { zones, count: zones.length }, debug_id });
  } catch (e) {
    return json(
      { ok: false, error: { code: "INTERNAL_ERROR", message: (e as Error).message }, debug_id },
      500,
    );
  }
}

// Registrazione runtime solo in Deno (edge). Sotto test/bundler l'handler
// viene importato direttamente senza attivare il server HTTP.
const denoRuntime = (globalThis as { Deno?: { serve?: (h: (req: Request) => Response | Promise<Response>) => unknown } }).Deno;
if (denoRuntime?.serve) {
  denoRuntime.serve((req: Request) => handleZonesList(req));
}
