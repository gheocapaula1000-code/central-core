// ═══════════════════════════════════════════════════════════════
// Geoportale Regione Veneto — CSW/WFS connector (DISCOVERY ONLY)
//
// Endpoints discovered (verified live):
//   - WFS:  https://idt2-geoserver.regione.veneto.it/geoserver/ows
//   - WMS:  https://idt2-geoserver.regione.veneto.it/geoserver/ows
//   - CSW:  https://idt2.regione.veneto.it/geoportal/csw
//   - WMTS: https://idt2.regione.veneto.it/gwc/service/wmts
//
// This module performs DRY RUN ONLY:
//   - GetCapabilities probing
//   - layer discovery + topic classification
//   - WFS sample GetFeature (count<=5) on top priority layers
//
// It MUST NOT write to any table. No source_documents, no
// territorial_signals, no radar_signals, no scores.
// ═══════════════════════════════════════════════════════════════

const WFS_URL = "https://idt2-geoserver.regione.veneto.it/geoserver/ows";
const WMS_URL = "https://idt2-geoserver.regione.veneto.it/geoserver/ows";
const CSW_URL = "https://idt2.regione.veneto.it/geoportal/csw";
const WMTS_URL = "https://idt2.regione.veneto.it/gwc/service/wmts";

type Topic = "vincoli" | "urbanistica" | "ambiente" | "rischio" | "parchi" | "paesaggio";

interface LayerInfo {
  layer_name: string;
  title: string;
  abstract?: string;
  service_type: "WFS" | "WMS" | "CSW";
  endpoint: string;
  bbox?: number[];
  crs?: string;
  topic: Topic | "altro";
  priority: number; // 1-5 (5 highest)
  importability:
    | "wfs_feature_importable"
    | "wms_visual_only"
    | "metadata_only"
    | "needs_review";
}

interface EndpointStatus {
  url: string;
  status: number;
  service_type: string;
  works: boolean;
  notes: string;
}

const TOPIC_RULES: Array<{ topic: Topic; patterns: RegExp[] }> = [
  { topic: "vincoli", patterns: [/vincol/i, /tutela/i, /nitrati/i] },
  { topic: "rischio", patterns: [/rischio/i, /alluvion/i, /pericol/i, /sismic/i, /fragil/i, /dissest/i, /valanghi/i, /frana/i] },
  { topic: "parchi", patterns: [/\bparch/i, /\briserva/i, /natura\s*2000/i, /sic\b/i, /zps\b/i] },
  { topic: "paesaggio", patterns: [/paesagg/i] },
  { topic: "urbanistica", patterns: [/\bPAT\b/, /\bPI\b/, /piano\s+intervent/i, /piano\s+regolat/i, /urbanist/i, /pianificazion/i, /consumo\s*suolo/i] },
  { topic: "ambiente", patterns: [/ambient/i, /forest/i, /verde/i, /idrogeolog/i, /qualita.*aria/i, /rumor/i] },
];

const KEYWORDS = [
  "vincol","paesagg","idrogeol","sismic","\\bPAT\\b","piano intervent",
  "aree tutelat","parch","riserva","rischio","fragil","pericol","alluvion",
  "dissest","ambient","consumo suolo","forest","nitrati"
];

function classify(text: string): { topic: Topic | "altro"; priority: number } {
  const t = text.toLowerCase();
  // Priority: vincoli/rischio = 5, urbanistica/paesaggio = 4, parchi/ambiente = 3
  for (const rule of TOPIC_RULES) {
    if (rule.patterns.some((re) => re.test(t))) {
      const pri =
        rule.topic === "vincoli" || rule.topic === "rischio" ? 5 :
        rule.topic === "urbanistica" || rule.topic === "paesaggio" ? 4 : 3;
      return { topic: rule.topic, priority: pri };
    }
  }
  return { topic: "altro", priority: 1 };
}

async function probeEndpoint(url: string, kind: string): Promise<EndpointStatus> {
  try {
    const r = await fetch(url, { method: "GET" });
    const txt = (await r.text()).slice(0, 400);
    const isXml = txt.includes("<?xml") || txt.includes("Capabilities");
    return {
      url, status: r.status, service_type: kind,
      works: r.ok && isXml,
      notes: r.ok ? (isXml ? "GetCapabilities XML returned" : "200 but not XML capabilities") : `HTTP ${r.status}`,
    };
  } catch (e) {
    return { url, status: 0, service_type: kind, works: false, notes: `fetch_error: ${(e as Error).message}` };
  }
}

async function discoverEndpoints(): Promise<EndpointStatus[]> {
  return await Promise.all([
    probeEndpoint(`${WFS_URL}?service=WFS&request=GetCapabilities&version=2.0.0`, "WFS"),
    probeEndpoint(`${WMS_URL}?service=WMS&request=GetCapabilities`, "WMS"),
    probeEndpoint(`${CSW_URL}?service=CSW&request=GetCapabilities`, "CSW"),
    probeEndpoint(`${WMTS_URL}?REQUEST=GetCapabilities`, "WMTS"),
  ]);
}

/** Parse WFS 2.0.0 GetCapabilities (regex-based, light parser). */
function parseWfsCapabilities(xml: string, topicsFilter?: Topic[]): LayerInfo[] {
  const out: LayerInfo[] = [];
  const blocks = xml.split(/<FeatureType\b/).slice(1);
  for (const raw of blocks) {
    const block = raw.split("</FeatureType>")[0];
    const name = block.match(/<Name>([^<]+)<\/Name>/)?.[1] ?? "";
    const title = block.match(/<Title>([^<]*)<\/Title>/)?.[1] ?? "";
    const abstract = block.match(/<Abstract>([^<]*)<\/Abstract>/)?.[1] ?? "";
    const crs = block.match(/<DefaultCRS>([^<]+)<\/DefaultCRS>/)?.[1];
    const bboxMatch = block.match(/<ows:LowerCorner>([^<]+)<\/ows:LowerCorner>\s*<ows:UpperCorner>([^<]+)<\/ows:UpperCorner>/);
    let bbox: number[] | undefined;
    if (bboxMatch) {
      const lc = bboxMatch[1].trim().split(/\s+/).map(Number);
      const uc = bboxMatch[2].trim().split(/\s+/).map(Number);
      if (lc.length === 2 && uc.length === 2) bbox = [lc[0], lc[1], uc[0], uc[1]];
    }
    const text = `${name} ${title} ${abstract}`;
    const hit = KEYWORDS.some((kw) => new RegExp(kw, "i").test(text));
    if (!hit) continue;
    const cls = classify(text);
    if (cls.topic === "altro") continue;
    if (topicsFilter && topicsFilter.length && !topicsFilter.includes(cls.topic as Topic)) continue;
    out.push({
      layer_name: name,
      title: title || name,
      abstract: abstract || undefined,
      service_type: "WFS",
      endpoint: WFS_URL,
      bbox, crs,
      topic: cls.topic as Topic,
      priority: cls.priority,
      importability: "wfs_feature_importable",
    });
  }
  // Sort by priority desc, then layer_name
  out.sort((a, b) => b.priority - a.priority || a.layer_name.localeCompare(b.layer_name));
  return out;
}

interface SampleResult {
  layer_name: string;
  features_read: number;
  geometry_type?: string;
  sample_properties: Record<string, unknown>[];
  property_keys: string[];
  has_comune?: boolean;
  has_provincia?: boolean;
  notes: string;
}

async function sampleWfsLayer(layer: LayerInfo, maxFeatures: number): Promise<SampleResult> {
  const url = `${WFS_URL}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(layer.layer_name)}&count=${maxFeatures}&outputFormat=application/json`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      return { layer_name: layer.layer_name, features_read: 0, sample_properties: [], property_keys: [], notes: `HTTP ${r.status}` };
    }
    const txt = await r.text();
    let json: any;
    try { json = JSON.parse(txt); }
    catch {
      return { layer_name: layer.layer_name, features_read: 0, sample_properties: [], property_keys: [], notes: "non_json_response (likely GML)" };
    }
    const feats = (json.features ?? []) as any[];
    const props = feats.map((f) => f.properties ?? {});
    const keys = props.length ? Object.keys(props[0]) : [];
    const lcKeys = keys.map((k) => k.toLowerCase());
    return {
      layer_name: layer.layer_name,
      features_read: feats.length,
      geometry_type: feats[0]?.geometry?.type,
      sample_properties: props.slice(0, 2),
      property_keys: keys.slice(0, 20),
      has_comune: lcKeys.some((k) => /comune|denom|nome/.test(k)),
      has_provincia: lcKeys.some((k) => /provincia|prov\b|sigla/.test(k)),
      notes: "ok",
    };
  } catch (e) {
    return { layer_name: layer.layer_name, features_read: 0, sample_properties: [], property_keys: [], notes: `fetch_error: ${(e as Error).message}` };
  }
}

const MAPPING_PROPOSAL = [
  { topic: "vincoli", target_table: "territorial_signals", signal_type: "planning_constraints_dataset", score_impact: "negative_constraint", quality: "official_regional", data_basis: "WFS GeoServer Regione Veneto" },
  { topic: "rischio", target_table: "territorial_signals", signal_type: "risk_constraint_dataset", score_impact: "negative_constraint", quality: "official_regional", data_basis: "WFS GeoServer Regione Veneto" },
  { topic: "urbanistica", target_table: "territorial_signals", signal_type: "urban_planning_dataset", score_impact: "context_modifier", quality: "official_regional", data_basis: "WFS GeoServer Regione Veneto" },
  { topic: "paesaggio", target_table: "territorial_signals", signal_type: "landscape_dataset", score_impact: "context_modifier", quality: "official_regional", data_basis: "WFS GeoServer Regione Veneto" },
  { topic: "parchi", target_table: "microzone_sentiment", signal_type: "green_score_dataset", score_impact: "positive_green", quality: "official_regional", data_basis: "WFS GeoServer Regione Veneto" },
  { topic: "ambiente", target_table: "microzone_sentiment", signal_type: "environment_dataset", score_impact: "context_modifier", quality: "official_regional", data_basis: "WFS GeoServer Regione Veneto" },
];

export interface GeoportaleDiscoveryParams {
  dryRun?: boolean;
  topics?: Topic[];
  maxLayers?: number;
  sampleFeatures?: boolean;
  maxFeaturesPerLayer?: number;
  import?: boolean;
}

export async function runGeoportaleVenetoDiscovery(params: GeoportaleDiscoveryParams) {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (params.import === true) {
    return {
      ok: false,
      error: "import_not_supported_in_discovery_phase",
      message: "This connector is in DISCOVERY-ONLY mode. Set import=false.",
    };
  }

  // FASE 1 — endpoints
  const endpoints_checked = await discoverEndpoints();
  const services_available = endpoints_checked.filter((e) => e.works).map((e) => e.service_type);

  // FASE 2 — layer discovery via WFS
  let layers_found: LayerInfo[] = [];
  const wfsOk = endpoints_checked.find((e) => e.service_type === "WFS")?.works;
  if (wfsOk) {
    try {
      const r = await fetch(`${WFS_URL}?service=WFS&request=GetCapabilities&version=2.0.0`);
      const xml = await r.text();
      layers_found = parseWfsCapabilities(xml, params.topics);
      const cap = params.maxLayers ?? 20;
      if (layers_found.length > cap) layers_found = layers_found.slice(0, cap);
    } catch (e) {
      errors.push(`wfs_capabilities_parse_error: ${(e as Error).message}`);
    }
  } else {
    warnings.push("WFS endpoint not reachable; layer discovery skipped.");
  }

  const layers_by_topic: Record<string, number> = {};
  for (const l of layers_found) layers_by_topic[l.topic] = (layers_by_topic[l.topic] ?? 0) + 1;

  const importable_layers = layers_found.filter((l) => l.importability === "wfs_feature_importable");

  // FASE 3 — WFS sample (top 3 by priority)
  let sample_features: SampleResult[] = [];
  if (params.sampleFeatures) {
    const top = importable_layers.slice(0, 3);
    const limit = params.maxFeaturesPerLayer ?? 5;
    sample_features = await Promise.all(top.map((l) => sampleWfsLayer(l, limit)));
  }

  // FASE 5/6 — return discovery payload
  return {
    ok: true,
    job: "geoportale-veneto-discovery",
    dryRun: params.dryRun !== false,
    import: false,
    endpoints_checked,
    services_available,
    layers_found_count: layers_found.length,
    layers_found,
    layers_by_topic,
    importable_layers_count: importable_layers.length,
    sample_features,
    mapping_proposal: MAPPING_PROPOSAL,
    warnings,
    errors,
    recommended_next_action:
      importable_layers.length > 0 && sample_features.some((s) => s.features_read > 0)
        ? "READY_FOR_REAL_IMPORT: enable spatial join (point-in-polygon) per comune via omi_zone_geometry/comuni table; persist as territorial_signals + source_documents in next phase."
        : "REVIEW_REQUIRED: no importable layers with valid sample features; expand topic filters or check CRS/outputFormat.",
  };
}
