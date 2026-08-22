// ═══════════════════════════════════════════════════════════════
// Internal Sottra context fetcher (server-side only).
//
// HARD RULES:
//   - Never exposed to the PWA. Caller MUST consume the structured
//     output and never echo raw payloads back to the client.
//   - Never invents data. If a Sottra route is unavailable or returns
//     no usable data, the corresponding context field stays null.
//   - Never throws. All errors degrade to null + warning.
//   - The word "Sottra" never appears in returned user-facing strings.
// ═══════════════════════════════════════════════════════════════

import { resolveInternalSecret } from "../_shared/http.ts";

const ROUTE_TIMEOUT_MS = 8_000;

// Sottra routes we attempt to use, in priority order.
// Each is best-effort; missing routes degrade gracefully.
const ROUTES = {
  identify:                "scan/identify",
  pricing:                 "scan/pricing",
  market:                  "scan/market",
  infrastrutture:          "forecast/infrastrutture",
  rischio:                 "forecast/rischio-zona",
  trendDemografico:        "forecast/trend-demografico",
  sviluppoArea:            "forecast/sviluppo-area",
  convergenzaTerritoriale: "forecast/convergenza-territoriale",
} as const;

type RouteKey = keyof typeof ROUTES;

export interface SottraInputContext {
  coords: { lat: number; lng: number } | null;
  manualAddress: string;
  zone: string;
  propertyType: string;
  sizeSqm: string;
  rooms: string;
  askingPrice: string;
}

export interface OmiDisplayItem { label: string; value: string }

export interface SottraIdentityHint {
  address: string | null;
  zone: string | null;
  municipality: string | null;
  confidenceLevel: "alta" | "media" | "bassa" | null;
}

export interface SottraOmiHint {
  available: boolean;
  status: "collegata" | "da_rivedere" | "da_collegare";
  displayItems: OmiDisplayItem[];
}

export interface SottraSignalHint {
  title: string;
  detail?: string;
  source?: string;
}

export interface PoiHint {
  supermercati: number;
  farmacie: number;
  scuole: number;
  parchi: number;
  fermateBus: number;
}

export interface SottraContext {
  used: boolean;
  identity: SottraIdentityHint | null;
  omi: SottraOmiHint | null;
  marketHints: SottraSignalHint[];
  infrastrutture: SottraSignalHint[];
  riskFlags: SottraSignalHint[];
  demographicHints: SottraSignalHint[];
  developmentHints: SottraSignalHint[];
  convergenceSummary: string | null;
  poiHints: PoiHint | null;
  warnings: string[];
}

function projectBaseUrl(): string | null {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return null;
  return `${url.replace(/\/$/, "")}/functions/v1`;
}

function deriveComuneProvincia(address: string): { comune: string; provincia: string } {
  const raw = (address || "").trim();
  if (!raw) return { comune: "", provincia: "" };
  const cleaned = raw.replace(/\b\d{5}\b/g, "").trim();
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && /^ital/i.test(parts[parts.length - 1])) parts.pop();
  const last = parts[parts.length - 1] ?? "";
  const provMatch = last.match(/\s+([A-Z]{2})$/);
  const provincia = provMatch ? provMatch[1] : "";
  const comune = last.replace(/\s+[A-Z]{2}$/, "").trim();
  return { comune, provincia };
}

function buildSottraBody(ctx: SottraInputContext): Record<string, unknown> {
  const { comune, provincia } = deriveComuneProvincia(ctx.manualAddress);
  return {
    address: ctx.manualAddress || "",
    comune: comune || undefined,
    provincia: provincia || undefined,
    lat: ctx.coords?.lat ?? 0,
    lng: ctx.coords?.lng ?? 0,
    zone: ctx.zone || undefined,
    propertyType: ctx.propertyType || "residenziale",
    areaSqm: Number(ctx.sizeSqm) || 0,
    rooms: ctx.rooms || undefined,
    askingPrice: Number(ctx.askingPrice) || 0,
  };
}

async function callSottra(
  route: string,
  body: Record<string, unknown>,
  baseUrl: string,
  secret: string,
  serviceKey: string,
  debugId: string,
): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ROUTE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/sottra/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
        "apikey": serviceKey,
        "x-internal-secret": secret,
        "x-source-app": "sottra",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`[civiko-internal-sottra] route=${route} status=${res.status} debug_id=${debugId}`);
      return { ok: false, data: null };
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object" && !Array.isArray(j)) parsed = j as Record<string, unknown>;
    } catch { /* ignore */ }
    // Many Central Core endpoints wrap into { ok, data, ... }
    const inner = parsed && typeof parsed.data === "object" && parsed.data !== null
      ? parsed.data as Record<string, unknown>
      : parsed;
    return { ok: true, data: inner };
  } catch (e) {
    console.warn(`[civiko-internal-sottra] route=${route} failed: ${e instanceof Error ? e.message : String(e)} debug_id=${debugId}`);
    return { ok: false, data: null };
  } finally {
    clearTimeout(timer);
  }
}

// ── Mappers (defensive, never throw, never invent) ────────────

function pickStr(o: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}
function pickNum(o: Record<string, unknown> | null | undefined, ...keys: string[]): number | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && !isNaN(Number(v))) return Number(v);
  }
  return null;
}

function mapIdentity(raw: Record<string, unknown> | null): SottraIdentityHint | null {
  if (!raw) return null;
  const address = pickStr(raw, "address", "fullAddress", "indirizzo");
  const zone = pickStr(raw, "zone", "zona", "neighborhood", "quartiere");
  const municipality = pickStr(raw, "municipality", "comune");
  const matchMethod = pickStr(raw, "matchMethod", "geoMatchLevel");
  const confidenceNum = pickNum(raw, "finalIdentityConfidence", "confidence", "geoConfidence");
  let confidenceLevel: "alta" | "media" | "bassa" | null = null;
  if (matchMethod === "polygon_match" || (confidenceNum != null && confidenceNum >= 0.8)) confidenceLevel = "alta";
  else if (confidenceNum != null && confidenceNum >= 0.5) confidenceLevel = "media";
  else if (confidenceNum != null && confidenceNum > 0) confidenceLevel = "bassa";
  if (!address && !zone && !municipality && !confidenceLevel) return null;
  return { address, zone, municipality, confidenceLevel };
}

function mapOmi(pricing: Record<string, unknown> | null): SottraOmiHint | null {
  if (!pricing) return null;
  // Common Sottra pricing fields. Do NOT invent: only emit if present.
  const zonaOmi = pickStr(pricing, "zonaOmi", "omiZone", "zona");
  const semestre = pickStr(pricing, "sourcePeriod", "semestre", "period");
  const tipologia = pickStr(pricing, "tipologia", "propertyType");
  const minRef = pickNum(pricing, "prezzoMqMin", "minRef", "minPriceSqm", "min", "valoreMinimo");
  const maxRef = pickNum(pricing, "prezzoMqMax", "maxRef", "maxPriceSqm", "max", "valoreMassimo");
  const matchMethod = pickStr(pricing, "omiMatchMethod", "matchMethod");
  const sourceType = pickStr(pricing, "sourceType");

  const items: OmiDisplayItem[] = [];
  if (zonaOmi) items.push({ label: "Zona OMI", value: zonaOmi });
  if (semestre) items.push({ label: "Semestre", value: semestre });
  if (tipologia) items.push({ label: "Tipologia", value: tipologia });
  if (minRef != null) items.push({ label: "Riferimento minimo", value: `${Math.round(minRef)} €/m²` });
  if (maxRef != null) items.push({ label: "Riferimento massimo", value: `${Math.round(maxRef)} €/m²` });
  if (sourceType === "official") items.push({ label: "Qualità fonte", value: "OMI ufficiale" });
  else if (sourceType === "elaborated") items.push({ label: "Qualità fonte", value: "OMI elaborata" });
  else if (sourceType === "unavailable") items.push({ label: "Qualità fonte", value: "Non disponibile" });

  if (items.length === 0) return null;

  let status: SottraOmiHint["status"];
  if (sourceType === "unavailable") status = "da_collegare";
  else if (sourceType === "official" || matchMethod === "polygon_match" || matchMethod === "single_zone") status = "collegata";
  else if (matchMethod && matchMethod !== "none") status = "da_rivedere";
  else status = "da_rivedere";
  items.push({
    label: "Stato Fonte",
    value: status === "collegata" ? "Riferimento Collegato" : status === "da_collegare" ? "Non Disponibile" : "Da Rivedere",
  });

  return { available: true, status, displayItems: items };
}

function asSignalList(raw: unknown, titleKeys: string[], detailKeys: string[], sourceLabel?: string): SottraSignalHint[] {
  if (!Array.isArray(raw)) return [];
  const out: SottraSignalHint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = pickStr(o, ...titleKeys);
    if (!title) continue;
    const detail = pickStr(o, ...detailKeys) ?? undefined;
    const source = pickStr(o, "source", "sourceOwner") ?? sourceLabel;
    out.push(source ? { title, detail, source } : { title, detail });
    if (out.length >= 6) break;
  }
  return out;
}

// ── Public entry point ────────────────────────────────────────

export async function runInternalSottraContext(
  ctx: SottraInputContext,
  debugId: string,
): Promise<SottraContext> {
  const empty: SottraContext = {
    used: false, identity: null, omi: null,
    marketHints: [], infrastrutture: [], riskFlags: [],
    demographicHints: [], developmentHints: [],
    convergenceSummary: null, poiHints: null, warnings: [],
  };

  const baseUrl = projectBaseUrl();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!baseUrl || !serviceKey) {
    empty.warnings.push("Contesto interno non disponibile: configurazione servizio incompleta.");
    return empty;
  }
  const { secret, mode } = resolveInternalSecret("sottra");
  if (!secret) {
    empty.warnings.push("Contesto interno non disponibile in questo ambiente.");
    return empty;
  }
  if (mode === "legacy") {
    console.warn(`[civiko-internal-sottra] using legacy shared secret debug_id=${debugId}`);
  }

  const hasGeo = !!ctx.coords;
  const hasAddress = ctx.manualAddress.length > 0;
  if (!hasGeo && !hasAddress) {
    empty.warnings.push("Contesto interno non interrogato: indirizzo o coordinate mancanti.");
    return empty;
  }

  const body = buildSottraBody(ctx);
  const wanted: RouteKey[] = ["identify", "pricing", "market", "infrastrutture", "rischio", "trendDemografico", "sviluppoArea", "convergenzaTerritoriale"];

  const settled = await Promise.allSettled(
    wanted.map((k) => callSottra(ROUTES[k], body, baseUrl, secret, serviceKey, debugId)),
  );

  const results: Partial<Record<RouteKey, Record<string, unknown> | null>> = {};
  let okCount = 0;
  settled.forEach((r, i) => {
    const key = wanted[i];
    if (r.status === "fulfilled" && r.value.ok) {
      results[key] = r.value.data;
      okCount++;
    } else {
      results[key] = null;
    }
  });

  if (okCount === 0) {
    empty.warnings.push("Contesto interno non disponibile in questo momento.");
    return empty;
  }

  const out: SottraContext = {
    used: true,
    identity: mapIdentity(results.identify ?? null),
    omi: mapOmi(results.pricing ?? null),
    marketHints: asSignalList(
      (results.market && (results.market.signals ?? results.market.items ?? results.market.references)) ?? [],
      ["title", "label", "name"], ["summary", "detail", "description"], "Riferimenti di Mercato",
    ),
    infrastrutture: asSignalList(
      (results.infrastrutture && (results.infrastrutture.items ?? results.infrastrutture.signals ?? results.infrastrutture.list)) ?? [],
      ["title", "name", "label"], ["summary", "detail", "description"], "Infrastrutture",
    ),
    riskFlags: asSignalList(
      (results.rischio && (results.rischio.flags ?? results.rischio.items ?? results.rischio.risks)) ?? [],
      ["title", "name", "label"], ["summary", "detail", "description"], "Verifiche di Supporto",
    ),
    demographicHints: asSignalList(
      (results.trendDemografico && (results.trendDemografico.items ?? results.trendDemografico.signals)) ?? [],
      ["title", "name", "label"], ["summary", "detail", "description"], "Contesto di Quartiere",
    ),
    developmentHints: asSignalList(
      (results.sviluppoArea && (results.sviluppoArea.items ?? results.sviluppoArea.signals ?? results.sviluppoArea.developments)) ?? [],
      ["title", "name", "label"], ["summary", "detail", "description"], "Segnali di Zona",
    ),
    convergenceSummary: pickStr(results.convergenzaTerritoriale ?? null, "summary", "narrative", "label"),
    poiHints: (() => {
      const pd = (results.infrastrutture as Record<string, unknown> | null | undefined)?.poiData;
      if (!pd || typeof pd !== "object") return null;
      const o = pd as Record<string, unknown>;
      const n = (k: string) => {
        const v = o[k];
        return typeof v === "number" && Number.isFinite(v) ? v : 0;
      };
      const hint = {
        supermercati: n("supermercati"),
        farmacie: n("farmacie"),
        scuole: n("scuole"),
        parchi: n("parchi"),
        fermateBus: n("fermateBus"),
      };
      const total = hint.supermercati + hint.farmacie + hint.scuole + hint.parchi + hint.fermateBus;
      return total > 0 ? hint : null;
    })(),
    warnings: [],
  };

  if (okCount < wanted.length) {
    out.warnings.push("Alcune verifiche di contesto non sono disponibili: la sezione resta parziale.");
  }
  return out;
}
