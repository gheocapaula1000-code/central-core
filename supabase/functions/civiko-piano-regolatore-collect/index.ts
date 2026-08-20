// civiko-piano-regolatore-collect
// Official Comune di Padova PAT/PI pages + Regione Veneto WFS.
// Fail-closed if no official source can be read. Never invents plan metrics.

import { createClient } from "npm:@supabase/supabase-js@2";
import { isJobSecretAuthorized, jobAuthFailure } from "../_shared/jobAuth.ts";
import {
  COLLECTOR_WALL_MS,
  FETCH_TIMEOUT_MS,
  PIANO_SOURCE_PAGES,
  WFS_REGIONE_VENETO,
  collectorTimedOut,
  extractOfficialElaborati,
  fetchWithTimeout,
  mapWfsFeatureToPiano,
  parseWfsFeatureTypes,
  type PianoRecord,
} from "../_shared/padovaUrbanLayers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-job-secret, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!isJobSecretAuthorized(req.headers, jobSecret)) {
    const auth = jobAuthFailure(Boolean(jobSecret));
    return json(auth.status, { ok: false, error: auth.error });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const started = Date.now();
  const fetchedAt = new Date().toISOString();
  const rows: PianoRecord[] = [];
  const errors: string[] = [];
  let sourcesRead = 0;

  try {
    for (const page of PIANO_SOURCE_PAGES) {
      if (collectorTimedOut(started, Date.now())) break;
      const r = await fetchWithTimeout(page, FETCH_TIMEOUT_MS);
      if (!r.ok) {
        errors.push(`pat_page:${r.error}`);
        continue;
      }
      sourcesRead++;
      rows.push(...extractOfficialElaborati(r.text, page, fetchedAt));
    }

    if (!collectorTimedOut(started, Date.now(), COLLECTOR_WALL_MS - 20_000)) {
      const caps = await fetchWithTimeout(
        `${WFS_REGIONE_VENETO}?service=WFS&request=GetCapabilities&version=2.0.0`,
        20_000,
      );
      if (!caps.ok) {
        errors.push(`wfs_caps:${caps.error}`);
      } else {
        sourcesRead++;
        const layers = parseWfsFeatureTypes(caps.text).slice(0, 4);
        for (const layer of layers) {
          if (collectorTimedOut(started, Date.now())) break;
          const url =
            `${WFS_REGIONE_VENETO}?service=WFS&version=2.0.0&request=GetFeature` +
            `&typeNames=${encodeURIComponent(layer.name)}&count=40` +
            `&outputFormat=application/json&srsName=EPSG:4326`;
          const feat = await fetchWithTimeout(url, 20_000);
          if (!feat.ok) {
            errors.push(`wfs:${layer.name}:${feat.error}`);
            continue;
          }
          sourcesRead++;
          try {
            const geo = JSON.parse(feat.text);
            const features = Array.isArray(geo?.features) ? geo.features : [];
            for (const f of features) {
              const mapped = mapWfsFeatureToPiano(layer.name, layer.title, f, fetchedAt);
              if (mapped) rows.push(mapped);
            }
          } catch {
            errors.push(`wfs_parse:${layer.name}`);
          }
        }
      }
    }

    if (sourcesRead === 0) {
      return json(502, {
        ok: false,
        error: "official_sources_unreadable",
        records_processed: 0,
        errors: errors.slice(0, 8),
      });
    }

    const seen = new Set<string>();
    const unique = rows.filter((r) => {
      if (seen.has(r.fingerprint)) return false;
      seen.add(r.fingerprint);
      return true;
    });

    let written = 0;
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      const { error } = await sb.from("padova_piano_regolatore").upsert(chunk, {
        onConflict: "fingerprint",
      });
      if (error) {
        errors.push(`upsert:${error.message}`);
        break;
      }
      written += chunk.length;
    }

    return json(written > 0 || unique.length === 0 ? 200 : 502, {
      ok: unique.length === 0 || written > 0,
      records_processed: written,
      sources_read: sourcesRead,
      empty: written === 0,
      duration_ms: Date.now() - started,
      errors: errors.slice(0, 8),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { ok: false, error: msg.slice(0, 200), records_processed: 0 });
  }
});
