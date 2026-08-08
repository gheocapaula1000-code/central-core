// _shared/padovaZoneResolver.ts
// Zone resolution for Padova signals — single source of truth.
// Used by:
//   - civiko-one-signals-feed  (schema civiko_signals_feed_v1)
//   - core-radar-signals-list
//
// Logic (same as civiko_signals_feed_v1):
//   1) sync OMI resolver (precomputed code / alias / cap salvage)
//   2) if still UNRESOLVED and we have a zone label (e.g. quartiere),
//      fallback lookup on public.quartiere_zona_map joined with
//      public.civiko_commercial_zones (display name = zone `nome`).

import {
  resolvePadovaOmiSync,
  UNRESOLVED_OMI_CODE,
  UNRESOLVED_OMI_LABEL,
} from "./padovaOmiResolver.ts";

export { UNRESOLVED_OMI_CODE, UNRESOLVED_OMI_LABEL };

/**
 * Resolve a free-text zone name (e.g. `payload.zona`) into a canonical
 * `{ zone_code, display_zone }` using the same PADOVA_OMI_ZONES table already
 * used by `resolvePadovaOmiSync` (no second map).
 *
 * Normalization:
 *  - case & accent insensitive
 *  - strips optional directional prefix "Nord - ", "Sud - ", "Est - ", "Ovest - "
 *
 * If the name cannot be resolved:
 *   { zone_code: "UNRESOLVED_ZONE", display_zone: null }
 */
export function resolveZoneByName(
  name: unknown,
): { zone_code: string; display_zone: string | null } {
  const raw = typeof name === "string" ? name : "";
  if (!raw.trim()) {
    return { zone_code: UNRESOLVED_OMI_CODE, display_zone: null };
  }
  // Strip accents + lowercase for prefix detection.
  const stripped = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  // Strip directional prefixes, including compounds like "Sud-Est - ", "Nord Ovest — ".
  const withoutPrefix = stripped.replace(
    /^\s*(nord|sud|est|ovest)(\s*[-–—]?\s*(est|ovest))?\s*[-–—:]\s*/i,
    "",
  ).trim();
  if (!withoutPrefix) {
    return { zone_code: UNRESOLVED_OMI_CODE, display_zone: null };
  }
  // Explicit aliases for labels currently left UNRESOLVED by the OMI resolver.
  const aliasKey = withoutPrefix.toLowerCase().replace(/\s+/g, " ").trim();
  const HARDCODED_ALIASES: Record<string, { zone_code: string; display_zone: string }> = {
    // Contratto v2: Forcellini è Nord-Est, Camin è Est-Brenta. L'etichetta
    // composta attraversa due zone e resta volutamente non risolta.
    "forcellini":         { zone_code: "D8", display_zone: "Forcellini" },
    "terranegra":         { zone_code: "D8", display_zone: "Terranegra" },
    "san gregorio":       { zone_code: "D8", display_zone: "San Gregorio" },
    "camin":              { zone_code: "E1", display_zone: "Camin" },
    "brenta":             { zone_code: "D4", display_zone: "Ponte di Brenta / Camin" },
    "ponte di brenta":    { zone_code: "D4", display_zone: "Ponte di Brenta / Camin" },
  };
  const hit = HARDCODED_ALIASES[aliasKey];
  if (hit) return hit;
  // Feed the cleaned name through the shared sync resolver so we reuse
  // PADOVA_OMI_ZONES aliases (single source of truth).
  const r = resolvePadovaOmiSync({ zona: withoutPrefix, quartiere: withoutPrefix });
  if (r && r.omi_zone_code && r.omi_zone_code !== UNRESOLVED_OMI_CODE) {
    return {
      zone_code: r.omi_zone_code,
      display_zone: r.omi_zone_label || null,
    };
  }
  return { zone_code: UNRESOLVED_OMI_CODE, display_zone: null };
}


export function resolveZoneFromRecord(
  record: Record<string, unknown>,
): { code: string; label: string } {
  try {
    const r = resolvePadovaOmiSync(record);
    if (r && r.omi_zone_code) {
      return { code: r.omi_zone_code, label: r.omi_zone_label || UNRESOLVED_OMI_LABEL };
    }
  } catch (_) { /* fall through */ }
  const omi = (record.omi_zone as string) || "";
  if (omi && omi.trim()) return { code: omi.trim(), label: (record.quartiere as string) || omi };
  const quart = (record.quartiere as string) || "";
  if (quart && quart.trim()) return { code: UNRESOLVED_OMI_CODE, label: quart.trim() };
  return { code: UNRESOLVED_OMI_CODE, label: UNRESOLVED_OMI_LABEL };
}

export function normalizeZoneKey(s: string | null | undefined): string {
  return (s || "").toString().toLowerCase().trim().replace(/\s+/g, " ");
}

type ZoneItem = {
  zone_code: string;
  zone_label: string;
  display_zone?: string;
  data_quality?: { flags: string[]; score: number };
};

/**
 * Fallback resolve via public.quartiere_zona_map for items still UNRESOLVED
 * but carrying a zone label (typically the quartiere name). Never invents a
 * code: only remaps when a row exists.
 */
export async function applyQuartiereZonaMapFallback<T extends ZoneItem>(
  supabase: {
    from: (t: string) => {
      select: (cols: string) => {
        in: (col: string, vals: string[]) => Promise<{ data: unknown; error: unknown }>;
      };
    };
  },
  items: T[],
): Promise<void> {
  const stillUnresolved = items.filter(
    (it) =>
      it.zone_code === UNRESOLVED_OMI_CODE &&
      it.zone_label &&
      it.zone_label !== UNRESOLVED_OMI_LABEL,
  );
  if (stillUnresolved.length === 0) return;

  const keys = Array.from(new Set(stillUnresolved.map((it) => normalizeZoneKey(it.zone_label))));
  const { data: mapRows, error: mapErr } = await supabase
    .from("quartiere_zona_map")
    .select("quartiere_key, omi_zone_code, zona_slug")
    .in("quartiere_key", keys);
  if (mapErr || !Array.isArray(mapRows) || mapRows.length === 0) return;

  const rows = mapRows as Array<Record<string, unknown>>;
  const slugs = Array.from(
    new Set(rows.map((r) => r.zona_slug as string).filter(Boolean)),
  );
  const slugToNome = new Map<string, string>();
  if (slugs.length > 0) {
    const { data: zoneRows } = await supabase
      .from("civiko_commercial_zones")
      .select("slug, nome")
      .in("slug", slugs);
    for (const z of ((zoneRows ?? []) as Array<Record<string, unknown>>)) {
      const s = z.slug as string;
      const n = z.nome as string;
      if (s && n) slugToNome.set(s, n);
    }
  }

  const keyToRes = new Map<string, { code: string; label: string }>();
  for (const r of rows) {
    const code = r.omi_zone_code as string | null;
    const key = r.quartiere_key as string | null;
    if (!code || !key) continue;
    const slug = r.zona_slug as string | null;
    const label = (slug && slugToNome.get(slug)) || code;
    keyToRes.set(key, { code, label });
  }

  for (const it of stillUnresolved) {
    const hit = keyToRes.get(normalizeZoneKey(it.zone_label));
    if (!hit) continue;
    it.zone_code = hit.code;
    it.zone_label = hit.label;
    it.display_zone = hit.label;
    if (it.data_quality) {
      it.data_quality.flags = it.data_quality.flags.filter((f) => f !== "unresolved_zone");
      it.data_quality.score = Math.max(0, 100 - it.data_quality.flags.length * 30);
    }
  }
}
