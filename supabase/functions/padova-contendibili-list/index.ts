// padova-contendibili-list — Edge Function (hardened, zone-isolated).
//
// Contract:
//   Server-to-server only. Called from PWA via core-proxy.
//   • x-source-app        → resolves per-app secret (requireSecret)
//   • x-internal-secret   → constant-time compared to AI_CORE_SECRET_<APP>
//   • x-workspace-id      → UUID; ONLY source of workspace identity
//     x-tenant-id is accepted as legacy alias from older PWA proxy calls.
//
// Zone isolation:
//   The workspace has exactly one assigned commercial zone. That zone is
//   resolved server-side from public.civiko_commercial_zones (occupata /
//   in_trial), validated against the 8-slug official contract, and used as
//   the ONLY filter for every DB read (list, total, hot_3plus, reachability).
//
//   Reads go through public.padova_contendibili_by_zone_v, which computes
//   commercial_zone_slug via civiko_resolve_commercial_zone_slug(quartiere).
//   No in-memory zone filter is used as a security control.
//
//   Client-supplied commercial_zone_slug / workspace_id are ignored.
//   Optional `quartiere` filter is accepted only if it resolves — via
//   commercialZoneForQuartiere — to the same assigned slug; otherwise the
//   request fails closed with 403.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireSecret, makeDebugId } from "../_shared/http.ts";
import { isCivikoCommercialZoneSlug } from "../_shared/civikoCommercialZoneContract.ts";
import { commercialZoneForQuartiere } from "../_shared/civikoCommercialZoneByQuartiere.ts";
import {
  applyCivikoSingleZoneGate,
} from "../_shared/civikoZoneAccessGate.ts";
import { MIN_AGENZIE_CONTESI } from "../_shared/contesi3PlusGate.ts";

/** HOT display threshold (independent from publication MIN). */
const HOT_AGENZIE_THRESHOLD = 3;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret, x-app-secret, x-core-secret, x-source-app, x-workspace-id, x-tenant-id, x-user-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const BANNED = /\b(AI|IA|intelligenza|stima|perizia|valutazione|valore reale|prezzo giusto|garantito|garantita|garantiti|garantite)\b/gi;
function sanitize(s: unknown): unknown {
  if (typeof s === "string") return s.replace(BANNED, "rilevato");
  if (Array.isArray(s)) return s.map(sanitize);
  if (s && typeof s === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) o[k] = sanitize(v);
    return o;
  }
  return s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_COLS =
  "id, chiave_match, n_agenzie, agenzie, agencies_normalized, fonti, confidenza, " +
  "prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls, " +
  "prezzo_medio_zona_eur_mq, prezzo_immobile_eur_mq, differenza_zona_pct, " +
  "giorni_sul_mercato, data_primo_annuncio, ribasso_pct, n_ribassi, " +
  "is_ripubblicato, cambio_agenzia, giorni_fermo, n_portali, score_pressione, " +
  "commercial_zone_slug";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const did = makeDebugId();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "x-debug-id": did },
    });

  // ─── Gate 1: shared secret ─────────────────────────────────────────
  const secretFail = requireSecret(req, did);
  if (secretFail) return secretFail;

  // ─── Gate 2: workspace identity (header only) ──────────────────────
  const workspaceId = (req.headers.get("x-workspace-id") ?? req.headers.get("x-tenant-id") ?? "").trim();
  if (!UUID_RE.test(workspaceId)) {
    return json(
      { ok: false, debug_id: did, error: { code: "WORKSPACE_REQUIRED", message: "Missing or invalid workspace id" } },
      401,
    );
  }

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const url = new URL(req.url);

    // Client params — commercial_zone_slug & workspace_id from body/query are IGNORED.
    const quartiereRaw = ((body as Record<string, unknown>).quartiere ?? url.searchParams.get("quartiere") ?? null) as string | null;
    const min_agenzie = Math.max(
      Number((body as Record<string, unknown>).min_agenzie ?? url.searchParams.get("min_agenzie") ?? MIN_AGENZIE_CONTESI) || MIN_AGENZIE_CONTESI,
      MIN_AGENZIE_CONTESI,
    );
    const limit = Math.min(
      Math.max(Number((body as Record<string, unknown>).limit ?? url.searchParams.get("limit") ?? 500) || 500, 1),
      1000,
    );
    const offset = Math.max(
      Number((body as Record<string, unknown>).offset ?? url.searchParams.get("offset") ?? 0) || 0,
      0,
    );
    const tenantAgencyRaw = ((body as Record<string, unknown>).tenant_agency_name ?? url.searchParams.get("tenant_agency_name") ?? null) as string | null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ─── Server-side zone resolution ─────────────────────────────────
    const { data: zonesRows, error: zoneErr } = await supabase
      .from("civiko_commercial_zones")
      .select("slug,status,occupied_agency_id,trial_agency_id,trial_reserved_until")
      .or(
        `and(status.eq.occupata,occupied_agency_id.eq.${workspaceId}),` +
          `and(status.eq.in_trial,trial_agency_id.eq.${workspaceId})`,
      );
    if (zoneErr) {
      console.error(`[padova-contendibili-list] ${did} zone lookup`, zoneErr);
      return json({ ok: false, debug_id: did, error: { code: "DB_ERROR", message: "zone lookup failed" } }, 500);
    }

    const now = Date.now();
    const valid = (zonesRows ?? []).filter((z: Record<string, unknown>) => {
      if (z.status === "occupata" && z.occupied_agency_id === workspaceId) return true;
      if (
        z.status === "in_trial" &&
        z.trial_agency_id === workspaceId &&
        typeof z.trial_reserved_until === "string" &&
        new Date(z.trial_reserved_until as string).getTime() > now
      ) return true;
      return false;
    });

    let isAdmin = false;
    {
      const { data: adminRes } = await supabase.rpc("civiko_is_admin_agency", { _agency_id: workspaceId });
      isAdmin = adminRes === true;
    }

    let assignedSlugs: string[];
    if (isAdmin) {
      assignedSlugs = [
        "centro-storico", "nord-arcella", "est-brenta", "nord-est",
        "sud-est-sant-osvaldo", "sud-voltabarozzo-guizza", "sud-ovest-mandria",
        "ovest-chiesanuova-brentelle",
      ];
    } else {
      if (valid.length === 0) {
        return json({ ok: false, debug_id: did, error: { code: "NO_ZONE_ASSIGNED", message: "No active zone for workspace" } }, 403);
      }
      assignedSlugs = valid
        .map((z: Record<string, unknown>) => String(z.slug ?? ""))
        .filter((s) => isCivikoCommercialZoneSlug(s));
      if (assignedSlugs.length === 0) {
        return json({ ok: false, debug_id: did, error: { code: "SLUG_OUT_OF_CONTRACT", message: "Assigned slug not in contract" } }, 403);
      }
    }

    // Optional zone_slug: client may pick a specific authorized zone.
    const zoneSlugRaw = ((body as Record<string, unknown>).zone_slug ?? (body as Record<string, unknown>).commercial_zone_slug ?? url.searchParams.get("zone_slug") ?? url.searchParams.get("commercial_zone_slug") ?? null) as string | null;

    // Checkpoint 11B-A — gate "una sola zona ufficiale assegnata" (fail-closed).
    // L'admin owner verificato server-side non e' un'agenzia cliente: nessun gate monozona.
    if (!isAdmin) {
      const gate = applyCivikoSingleZoneGate(req.headers.get("x-source-app"), assignedSlugs, zoneSlugRaw);
      if (gate.civiko) {
        if (!gate.ok) {
          return json({ ok: false, debug_id: did, error: { code: gate.code, message: "Zone access denied" } }, 403);
        }
        assignedSlugs = gate.slugs;
        isAdmin = false;
      }
    }
    let activeSlugs = assignedSlugs;
    if (zoneSlugRaw && zoneSlugRaw.trim()) {
      if (!assignedSlugs.includes(zoneSlugRaw)) {
        return json({ ok: false, debug_id: did, error: { code: "ZONE_NOT_ASSIGNED", message: "Requested zone not assigned to workspace" } }, 403);
      }
      activeSlugs = [zoneSlugRaw];
    }

    // Optional quartiere filter must resolve to one of the authorized slugs.
    let quartiereFilter: string | null = null;
    if (quartiereRaw && quartiereRaw.trim()) {
      const resolved = commercialZoneForQuartiere(quartiereRaw);
      if (!resolved || !activeSlugs.includes(resolved)) {
        return json(
          { ok: false, debug_id: did, error: { code: "QUARTIERE_OUT_OF_ZONE", message: "Quartiere not in assigned zone" } },
          403,
        );
      }
      quartiereFilter = quartiereRaw;
      activeSlugs = [resolved];
    }

    // Apply the zone filter INSIDE the database — never in memory.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyZoneFilter = (q: any): any => {
      q = q.in("commercial_zone_slug", activeSlugs);
      if (quartiereFilter) q = q.eq("quartiere", quartiereFilter);
      return q;
    };

    // ─── Main list — filtered by zone at DB level ────────────────────
    let listQ = supabase
      .from("padova_contendibili_by_zone_v")
      .select(SELECT_COLS, { count: "exact" })
      .gte("n_agenzie", min_agenzie);
    listQ = applyZoneFilter(listQ)
      .order("score_pressione", { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await listQ;
    if (error) {
      console.error(`[padova-contendibili-list] ${did} list`, error);
      return json({ ok: false, debug_id: did, error: { code: "DB_ERROR", message: "list query failed" } }, 500);
    }

    const rank: Record<string, number> = { ALTA: 0, MEDIA: 1, DA_CONFERMARE: 2 };
    const rows = (data ?? []).slice().sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      const na = Number(a.n_agenzie ?? 0), nb = Number(b.n_agenzie ?? 0);
      if (nb !== na) return nb - na;
      return (rank[String(a.confidenza)] ?? 9) - (rank[String(b.confidenza)] ?? 9);
    });

    // ─── hot_3plus — same zone, DB-side count (always >=3, independent of MIN) ─
    const hotQ = applyZoneFilter(
      supabase
        .from("padova_contendibili_by_zone_v")
        .select("id", { count: "exact", head: true })
        .gte("n_agenzie", HOT_AGENZIE_THRESHOLD),
    );
    const { count: hotCount, error: hotErr } = await hotQ;
    if (hotErr) {
      console.error(`[padova-contendibili-list] ${did} hot`, hotErr);
      return json({ ok: false, debug_id: did, error: { code: "DB_ERROR", message: "hot query failed" } }, 500);
    }

    // ─── Reachability — restricted to already-authorized IDs ─────────
    const ids = rows.map((r) => Number(r.id)).filter((v) => Number.isFinite(v));
    const reachMap = new Map<number, { argento: boolean; count: number; hasPhone: boolean; bestListingId: number | null }>();
    if (ids.length > 0) {
      const { data: reachRows, error: reachErr } = await supabase
        .from("padova_contendibili_reachability_v")
        .select("id, reachability_argento, argento_match_count, argento_has_phone, argento_best_listing_id")
        .in("id", ids);
      if (reachErr) console.error(`[padova-contendibili-list] ${did} reach`, reachErr);
      for (const r of (reachRows ?? []) as Array<Record<string, unknown>>) {
        reachMap.set(Number(r.id), {
          argento: Boolean(r.reachability_argento),
          count: Number(r.argento_match_count ?? 0),
          hasPhone: Boolean(r.argento_has_phone),
          bestListingId: r.argento_best_listing_id == null ? null : Number(r.argento_best_listing_id),
        });
      }
    }

    // ─── Annunci lookup — join per-url su padova_listings ─────────────
    // Fail-open: se la riga non è trovata, `attivo = true` e `agenzia = null`.
    const allUrls: string[] = [];
    for (const r of rows) {
      const us = Array.isArray((r as Record<string, unknown>).urls) ? ((r as Record<string, unknown>).urls as unknown[]) : [];
      for (const u of us) if (typeof u === "string" && u) allUrls.push(u);
    }
    const listingByUrl = new Map<string, { id: number | null; agency: string | null; expired_at: string | null }>();
    if (allUrls.length > 0) {
      const uniq = Array.from(new Set(allUrls));
      const CHUNK = 200;
      for (let i = 0; i < uniq.length; i += CHUNK) {
        const slice = uniq.slice(i, i + CHUNK);
        const { data: lrows, error: lerr } = await supabase
          .from("padova_listings")
          .select("id, url, agency, expired_at")
          .in("url", slice);
        if (lerr) {
          console.error(`[padova-contendibili-list] ${did} listings lookup`, lerr);
          continue;
        }
        for (const lr of (lrows ?? []) as Array<Record<string, unknown>>) {
          const u = String(lr.url ?? "");
          if (!u) continue;
          listingByUrl.set(u, {
            id: Number.isFinite(Number(lr.id)) ? Number(lr.id) : null,
            agency: typeof lr.agency === "string" && lr.agency ? (lr.agency as string) : null,
            expired_at: typeof lr.expired_at === "string" ? (lr.expired_at as string) : null,
          });
        }
      }
    }

    // ─── Normalizzazione agenzia (dedup su nome, non su portale) ───────
    // «Affiliato Tecnocasa: Studio Enne» === «Studio Enne».
    const normAgencyName = (raw: unknown): string => {
      let s = String(raw ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      s = s.replace(/^\s*(affiliat[oa]|agenzia\s+affiliata|gruppo|rete)\b[^:]*:\s*/i, "");
      s = s.replace(/\b(s\.?r\.?l\.?s?|s\.?p\.?a|s\.?n\.?c|s\.?a\.?s|immobiliare|studio immobiliare|agenzia)\b/g, " ");
      s = s.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
      return s;
    };

    // ─── Prova fotografica certificata (obbligatoria) ──────────────────
    const PHOTO_MATCH_VERSION = "v4-padova-photo-pair";
    const groupListingIds = new Map<number, number[]>();
    const allListingIds = new Set<number>();
    for (const r of rows) {
      const us = Array.isArray((r as Record<string, unknown>).urls) ? ((r as Record<string, unknown>).urls as unknown[]) : [];
      const ids2: number[] = [];
      for (const u of us) {
        if (typeof u !== "string" || !u) continue;
        const lid = listingByUrl.get(u)?.id;
        if (typeof lid === "number") { ids2.push(lid); allListingIds.add(lid); }
      }
      groupListingIds.set(Number((r as Record<string, unknown>).id), ids2);
    }
    type PairEv = { a: number; b: number; agA: string; agB: string };
    const pairs: PairEv[] = [];
    if (allListingIds.size > 0) {
      const idsArr = Array.from(allListingIds);
      const CHUNK = 200;
      for (let i = 0; i < idsArr.length; i += CHUNK) {
        const slice = idsArr.slice(i, i + CHUNK);
        const { data: ev, error: evErr } = await supabase
          .from("civiko_listing_photo_pair_evidence")
          .select("listing_a, listing_b, agency_a, agency_b, match_version")
          .eq("match_version", PHOTO_MATCH_VERSION)
          .in("listing_a", slice);
        if (evErr) {
          console.error(`[padova-contendibili-list] ${did} photo evidence`, evErr);
          continue;
        }
        for (const e of (ev ?? []) as Array<Record<string, unknown>>) {
          pairs.push({
            a: Number(e.listing_a),
            b: Number(e.listing_b),
            agA: normAgencyName(e.agency_a),
            agB: normAgencyName(e.agency_b),
          });
        }
      }
    }
    const hasCertifiedPhotoPair = (rowId: number): boolean => {
      const ids2 = new Set(groupListingIds.get(rowId) ?? []);
      if (ids2.size < 2) return false;
      return pairs.some((p) =>
        ids2.has(p.a) && ids2.has(p.b) && p.agA !== "" && p.agB !== "" && p.agA !== p.agB
      );
    };

    const hostnameOf = (u: string): string => {
      try {
        const h = new URL(u).hostname.toLowerCase();
        return h.startsWith("www.") ? h.slice(4) : h;
      } catch {
        return "";
      }
    };

    // Tenant agency name — client-supplied value is NOT authoritative and
    // does NOT affect authorization or data access. It only influences the
    // per-row `reachability.tier` (oro vs argento/bronzo). Any misuse only
    // downgrades/upgrades the tier label; zone isolation is unaffected.
    let tenantNorm: string | null = null;
    if (tenantAgencyRaw && tenantAgencyRaw.trim()) {
      const { data: nn } = await supabase.rpc("norm_agency", { p: tenantAgencyRaw });
      tenantNorm = typeof nn === "string" && nn.trim() ? nn.trim() : null;
    }

    let droppedAgenzie = 0;
    let droppedNoPhoto = 0;

    const enriched = rows.map((r: Record<string, unknown>) => {
      const rr = reachMap.get(Number(r.id)) ?? { argento: false, count: 0, hasPhone: false, bestListingId: null };
      const agNorm = Array.isArray(r.agencies_normalized) ? (r.agencies_normalized as string[]) : [];
      const isOro = tenantNorm
        ? agNorm.some((a) => (a || "").toLowerCase().trim() === tenantNorm!.toLowerCase().trim())
        : false;
      const tier = isOro ? "oro" : (rr.argento ? "argento" : "bronzo");
      const urlsArr = Array.isArray((r as Record<string, unknown>).urls) ? ((r as Record<string, unknown>).urls as unknown[]).filter((u): u is string => typeof u === "string" && !!u) : [];
      const annunci = urlsArr.map((u) => {
        const found = listingByUrl.get(u);
        return {
          url: u,
          agenzia: found ? found.agency : null,
          portale: hostnameOf(u),
          attivo: found ? found.expired_at == null : true,
        };
      });

      // Ricalcolo agenzie distinte sul nome normalizzato (stesso nome su due
      // portali = 1 agenzia; prefisso "Affiliato X:" ignorato).
      const distinct = new Set<string>();
      for (const a of (Array.isArray(r.agenzie) ? (r.agenzie as unknown[]) : [])) {
        const n = normAgencyName(a);
        if (n) distinct.add(n);
      }
      for (const a of agNorm) {
        const n = normAgencyName(a);
        if (n) distinct.add(n);
      }
      for (const an of annunci) {
        const n = normAgencyName(an.agenzia);
        if (n) distinct.add(n);
      }
      const nAgenzieNorm = distinct.size;

      return {
        ...r,
        n_agenzie: nAgenzieNorm,
        agencies_normalized: Array.from(distinct),
        confidenza: "ALTA",
        source_id: `cont:${Number(r.id)}`,
        reachability: {
          tier,
          argento_match_count: rr.count,
          argento_has_phone: rr.hasPhone,
          argento_best_listing_id: rr.bestListingId,
        },
        annunci,
        _n_agenzie_norm: nAgenzieNorm,
        _photo_pair_certified: hasCertifiedPhotoPair(Number(r.id)),
      };
    }).filter((r) => {
      if ((r._n_agenzie_norm as number) < MIN_AGENZIE_CONTESI) { droppedAgenzie++; return false; }
      if (r._photo_pair_certified !== true) { droppedNoPhoto++; return false; }
      return true;
    }).map((r) => {
      const { _n_agenzie_norm: _a, _photo_pair_certified: _b, ...rest } = r as Record<string, unknown>;
      return rest;
    });

    // Diagnostics — computed on already-zone-filtered rows only.
    const sourceBreakdown: Record<string, number> = {};
    const quartiereBreakdown: Record<string, number> = {};
    for (const r of enriched) {
      for (const f of ((r as Record<string, unknown>).fonti as string[] ?? [])) {
        sourceBreakdown[f] = (sourceBreakdown[f] ?? 0) + 1;
      }
      const q2 = ((r as Record<string, unknown>).quartiere ?? "n/d").toString();
      quartiereBreakdown[q2] = (quartiereBreakdown[q2] ?? 0) + 1;
    }

    const totalOut = enriched.length;
    const hot = enriched.filter((r) => Number((r as Record<string, unknown>).n_agenzie ?? 0) >= HOT_AGENZIE_THRESHOLD).length;

    const primarySlug = activeSlugs.length === 1 ? activeSlugs[0] : null;
    const diagnostics = {
      scope: "commercial_zone_isolated",
      assigned_zone: primarySlug,
      assigned_zones: assignedSlugs,
      active_zones: activeSlugs,
      quartiere_filter: quartiereFilter,
      total_after_filters: totalOut,
      returned: enriched.length,
      raw_candidates: count ?? rows.length,
      dropped_agenzie_dedup: droppedAgenzie,
      dropped_no_photo_pair: droppedNoPhoto,
      photo_match_version: PHOTO_MATCH_VERSION,
      source_breakdown: sourceBreakdown,
      quartiere_breakdown: quartiereBreakdown,
    };

    const filtered = enriched; // Kept name for shape-preservation in tests.


    const itemsCount = filtered.length;
    const snapshotComplete = itemsCount === totalOut && offset === 0;

    const payload = sanitize({
      ok: true,
      data: {
        items: filtered,
        total: totalOut,
        items_count: itemsCount,
        snapshot_complete: snapshotComplete,
        assigned_zone: primarySlug,
        assigned_zones: assignedSlugs,
        active_zones: activeSlugs,
        hot_3plus: hot,
        offset,
        limit,
        diagnostics,
      },
      total: totalOut,
      items_count: itemsCount,
      snapshot_complete: snapshotComplete,
      diagnostics,
      assigned_zone: primarySlug,
      assigned_zones: assignedSlugs,
      active_zones: activeSlugs,
      debug_id: did,
    });

    return new Response(JSON.stringify(payload), { status: 200, headers: CORS });
  } catch (e) {
    console.error(`[padova-contendibili-list] ${did}`, e);
    return new Response(JSON.stringify({
      ok: false, data: null, debug_id: did,
      error: { code: "INTERNAL_ERROR", message: "internal error" },
    }), { status: 500, headers: CORS });
  }
});
