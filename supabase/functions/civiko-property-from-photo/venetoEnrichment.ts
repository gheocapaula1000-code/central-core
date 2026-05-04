// ═══════════════════════════════════════════════════════════════
// Veneto Enrichment Module — Central Core
//
// Produces the additive Veneto-only fields required by Civiko One
// (venetoScope, omiZona, competizioneAttiva, dataQuality, etc.)
// without touching the legacy contract. Pure, defensive, never
// throws, never invents real data.
// ═══════════════════════════════════════════════════════════════

const VENETO_PROVINCES = new Set(["VE", "VR", "VI", "PD", "TV", "BL", "RO"]);
type VenetoProv = "VE" | "VR" | "VI" | "PD" | "TV" | "BL" | "RO";

// Veneto bbox (loose) for the no-address / no-RPC fallback.
const VENETO_BBOX = { latMin: 44.78, latMax: 46.71, lngMin: 10.62, lngMax: 13.13 };

export type TipologiaPresunta =
  | "appartamento" | "villa" | "villetta" | "rustico"
  | "casa_indipendente" | "bifamiliare" | "trifamiliare"
  | "schiera" | "attico" | "terreno" | "commerciale" | "sconosciuto";

export type StatoApparente =
  | "nuovo" | "ottimo" | "buono" | "da_rimodernare" | "da_ristrutturare" | "sconosciuto";

export interface VenetoScope {
  isInVeneto: boolean;
  comune: string | null;
  provincia: VenetoProv | null;
  confidence: number;
  reason: string;
}

export interface OmiZonaOut {
  available: boolean;
  comune: string | null;
  provincia: string | null;
  microzona: string | null;
  fascia: string | null;
  valoreMin: number | null;
  valoreMax: number | null;
  valoreMedio: number | null;
  sourceAnchor: string | null;
  quality: "reale" | "stimato" | "mancante";
}

export interface CompetizioneAttiva {
  available: boolean;
  annunciAttiviStimati: number | null;
  ribassiUltimoMese: number | null;
  asteVicine: number | null;
  pressioneCompetitiva: "bassa" | "media" | "alta" | "sconosciuta";
  note: string;
}

export interface ImmobileEnrichment {
  tipologiaPresunta: TipologiaPresunta;
  statoApparente: StatoApparente;
  puntiForti: string[];
  criticitaVisibili: string[];
  provincia: VenetoProv | null;
  comune: string | null;
}

export interface DataQuality {
  real: string[];
  estimated: string[];
  missing: string[];
  warnings: string[];
}

interface EnrichInput {
  coords: { lat: number; lng: number } | null;
  manualAddress: string;
  hasUsablePhoto: boolean;
  facts: {
    tipologia?: string;
    metratura?: string;
    locali?: string;
    zona?: string;
    titoloInterno?: string;
    prezzoRichiesto?: string;
  };
}

// ── small utils ───────────────────────────────────────────────

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function inBbox(lat: number, lng: number): boolean {
  return lat >= VENETO_BBOX.latMin && lat <= VENETO_BBOX.latMax &&
         lng >= VENETO_BBOX.lngMin && lng <= VENETO_BBOX.lngMax;
}

function parseProvinciaFromAddress(addr: string): VenetoProv | null {
  if (!addr) return null;
  const m = addr.match(/\b(VE|VR|VI|PD|TV|BL|RO)\b/);
  if (m && VENETO_PROVINCES.has(m[1])) return m[1] as VenetoProv;
  const lower = addr.toLowerCase();
  if (/\bveneziaa?\b|\bvenezia\b|\bmestre\b/.test(lower)) return "VE";
  if (/\bverona\b/.test(lower)) return "VR";
  if (/\bvicenza\b/.test(lower)) return "VI";
  if (/\bpadova\b/.test(lower)) return "PD";
  if (/\btreviso\b/.test(lower)) return "TV";
  if (/\bbelluno\b/.test(lower)) return "BL";
  if (/\brovigo\b/.test(lower)) return "RO";
  return null;
}

function parseComuneFromAddress(addr: string): string | null {
  if (!addr) return null;
  const cleaned = addr.replace(/\b\d{5}\b/g, "").trim();
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length > 1 && /^ital/i.test(parts[parts.length - 1])) parts.pop();
  const last = parts[parts.length - 1] ?? "";
  const c = last.replace(/\s+(VE|VR|VI|PD|TV|BL|RO)$/i, "").trim();
  return c || null;
}

// ── Supabase REST helpers (service role) ──────────────────────

function supaBase(): { url: string; key: string } | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

async function rpcZoneByPoint(lat: number, lng: number): Promise<{
  comune: string | null; provincia: string | null; zona: string | null;
  zonaDescr: string | null; comuneIstat: string | null; linkZona: string | null;
} | null> {
  const cfg = supaBase();
  if (!cfg) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4_000);
    const res = await fetch(`${cfg.url}/rest/v1/rpc/omi_zone_by_point`, {
      method: "POST",
      headers: {
        "apikey": cfg.key, "Authorization": `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_lat: lat, p_lng: lng }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const arr = await res.json() as Array<Record<string, unknown>>;
    const row = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
    if (!row) return null;
    return {
      comune: typeof row.comune_descrizione === "string" ? row.comune_descrizione : null,
      provincia: typeof row.provincia === "string" ? row.provincia : null,
      zona: typeof row.zona === "string" ? row.zona : null,
      zonaDescr: typeof row.zona_descr === "string" ? row.zona_descr : null,
      comuneIstat: typeof row.comune_istat === "string" ? row.comune_istat : null,
      linkZona: typeof row.link_zona === "string" ? row.link_zona : null,
    };
  } catch { return null; }
}

async function fetchOmiValori(linkZona: string | null, comuneIstat: string | null): Promise<{
  min: number | null; max: number | null; fascia: string | null; tipologia: string | null;
} | null> {
  const cfg = supaBase();
  if (!cfg) return null;
  try {
    const params = new URLSearchParams();
    params.set("select", "compr_min,compr_max,fascia,descr_tipologia,zona");
    params.set("descr_tipologia", "ilike.*abitazion*");
    if (linkZona) params.set("link_zona", `eq.${linkZona}`);
    else if (comuneIstat) params.set("comune_istat", `eq.${comuneIstat}`);
    else return null;
    params.set("limit", "20");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4_000);
    const res = await fetch(`${cfg.url}/rest/v1/omi_valori?${params}`, {
      headers: { "apikey": cfg.key, "Authorization": `Bearer ${cfg.key}` },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const rows = await res.json() as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const mins: number[] = [], maxs: number[] = [];
    for (const r of rows) {
      const lo = Number(r.compr_min), hi = Number(r.compr_max);
      if (Number.isFinite(lo) && lo > 0) mins.push(lo);
      if (Number.isFinite(hi) && hi > 0) maxs.push(hi);
    }
    if (mins.length === 0 && maxs.length === 0) return null;
    const min = mins.length ? Math.min(...mins) : null;
    const max = maxs.length ? Math.max(...maxs) : null;
    const fascia = typeof rows[0].fascia === "string" ? rows[0].fascia as string : null;
    const tipologia = typeof rows[0].descr_tipologia === "string" ? rows[0].descr_tipologia as string : null;
    return { min, max, fascia, tipologia };
  } catch { return null; }
}

async function countCompetition(
  provincia: string | null, comune: string | null,
): Promise<{ active: number | null; ribassi: number | null }> {
  const cfg = supaBase();
  if (!cfg) return { active: null, ribassi: null };
  const headers = { "apikey": cfg.key, "Authorization": `Bearer ${cfg.key}`, "Prefer": "count=exact" };

  const filterCommon = new URLSearchParams();
  if (comune) filterCommon.set("municipality", `ilike.${comune}`);
  else if (provincia) filterCommon.set("province", `eq.${provincia}`);
  else return { active: null, ribassi: null };

  async function head(table: string, extra: string[] = []): Promise<number | null> {
    try {
      const p = new URLSearchParams(filterCommon);
      for (const e of extra) {
        const [k, v] = e.split("=");
        p.append(k, v);
      }
      p.set("select", "id");
      p.set("limit", "1");
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4_000);
      const res = await fetch(`${cfg.url}/rest/v1/${table}?${p}`, { method: "HEAD", headers, signal: ctrl.signal });
      clearTimeout(t);
      const cr = res.headers.get("content-range");
      if (!cr) return null;
      const m = cr.match(/\/(\d+|\*)$/);
      if (!m || m[1] === "*") return null;
      return Number(m[1]);
    } catch { return null; }
  }

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const [active, ribassi] = await Promise.all([
    head("listing_price_snapshots", [`captured_at=gte.${since}`]),
    head("motivated_sellers", [`is_active=eq.true`, `drops_count=gte.1`]),
  ]);
  return { active, ribassi };
}

// ── derivations ───────────────────────────────────────────────

export function deriveTipologia(
  facts: EnrichInput["facts"],
): TipologiaPresunta {
  const raw = (facts.tipologia ?? "").toLowerCase().trim();
  const title = (facts.titoloInterno ?? "").toLowerCase();
  const blob = `${raw} ${title}`;
  if (!blob.trim()) return "sconosciuto";
  const map: Array<[RegExp, TipologiaPresunta]> = [
    [/villetta|villino/, "villetta"],
    [/villa\b/, "villa"],
    [/rustico|casale|cascin/, "rustico"],
    [/bifamiliar/, "bifamiliare"],
    [/trifamiliar/, "trifamiliare"],
    [/schiera/, "schiera"],
    [/attico|mansard/, "attico"],
    [/indipenden/, "casa_indipendente"],
    [/terreno|lotto/, "terreno"],
    [/commercial|negozio|capannone|ufficio/, "commerciale"],
    [/appartamento|trilocal|bilocal|quadrilocal|monolocal/, "appartamento"],
  ];
  for (const [re, t] of map) if (re.test(blob)) return t;
  // default per residenziale generico
  return "appartamento";
}

export function deriveStato(facts: EnrichInput["facts"]): StatoApparente {
  const blob = `${facts.titoloInterno ?? ""}`.toLowerCase();
  if (/nuova costruz|nuovo\b/.test(blob)) return "nuovo";
  if (/ottimo|ristrutturato di recente|ristrutturat[oa]\b/.test(blob)) return "ottimo";
  if (/da ristruttura/.test(blob)) return "da_ristrutturare";
  if (/da rimoderna|da ammoderna|da rinnova/.test(blob)) return "da_rimodernare";
  if (/buono\b/.test(blob)) return "buono";
  return "sconosciuto";
}

export function derivePuntiForti(
  input: EnrichInput,
  scope: VenetoScope,
  omi: OmiZonaOut,
): string[] {
  const out: string[] = [];
  if (input.facts.zona && input.facts.zona.length > 1) {
    out.push(`Contesto identificato: zona ${input.facts.zona}.`);
  }
  if (scope.comune) out.push(`Posizionamento in ${scope.comune}, area monitorata.`);
  if (omi.available && omi.valoreMedio) {
    out.push("Riferimenti OMI di zona disponibili per impostare il prezzo.");
  }
  if (input.coords) out.push("Geolocalizzazione confermata: contesto verificabile.");
  if (input.facts.tipologia) out.push("Tipologia dichiarata: presentazione mirata possibile.");
  return out.slice(0, 5);
}

export function deriveCriticita(
  input: EnrichInput,
  omi: OmiZonaOut,
  comp: CompetizioneAttiva,
): string[] {
  const out: string[] = [];
  if (!input.hasUsablePhoto) out.push("Valorizzazione fotografica da migliorare per la pubblicazione.");
  if (!omi.available || omi.quality !== "reale") out.push("Prezzo da validare con comparabili locali aggiornati.");
  if (comp.pressioneCompetitiva === "alta") out.push("Concorrenza attiva nella stessa fascia di prezzo in zona.");
  if (comp.ribassiUltimoMese && comp.ribassiUltimoMese > 0) {
    out.push("Ribassi rilevati in zona: gestire con attenzione il prezzo di partenza.");
  }
  if (!input.facts.metratura) out.push("Metratura non dichiarata: validare per calcolo €/m².");
  return out.slice(0, 5);
}

// ── public builders ───────────────────────────────────────────

export async function buildVenetoScope(input: EnrichInput): Promise<{
  scope: VenetoScope; comuneIstat: string | null; linkZona: string | null;
}> {
  // Prefer RPC by coords (gives provincia/comune from omi_zone_geometry)
  if (input.coords) {
    const row = await rpcZoneByPoint(input.coords.lat, input.coords.lng);
    if (row && row.provincia && VENETO_PROVINCES.has(row.provincia)) {
      return {
        scope: {
          isInVeneto: true,
          comune: row.comune,
          provincia: row.provincia as VenetoProv,
          confidence: 0.95,
          reason: "Coordinate ricadute in microzona OMI veneta.",
        },
        comuneIstat: row.comuneIstat,
        linkZona: row.linkZona,
      };
    }
    if (inBbox(input.coords.lat, input.coords.lng)) {
      const provFromAddr = parseProvinciaFromAddress(input.manualAddress);
      return {
        scope: {
          isInVeneto: true,
          comune: parseComuneFromAddress(input.manualAddress),
          provincia: provFromAddr,
          confidence: 0.55,
          reason: "Coordinate in bounding box Veneto, microzona non risolta.",
        },
        comuneIstat: null, linkZona: null,
      };
    }
    return {
      scope: {
        isInVeneto: false, comune: null, provincia: null,
        confidence: 0.9, reason: "Coordinate fuori dal Veneto.",
      },
      comuneIstat: null, linkZona: null,
    };
  }

  const prov = parseProvinciaFromAddress(input.manualAddress);
  const comune = parseComuneFromAddress(input.manualAddress);
  if (prov) {
    return {
      scope: {
        isInVeneto: true, comune, provincia: prov,
        confidence: 0.7, reason: "Provincia veneta dedotta dall'indirizzo manuale.",
      },
      comuneIstat: null, linkZona: null,
    };
  }
  return {
    scope: {
      isInVeneto: false, comune, provincia: null,
      confidence: 0.2, reason: "Né coordinate né provincia veneta riconoscibili.",
    },
    comuneIstat: null, linkZona: null,
  };
}

export async function buildOmiZona(
  scope: VenetoScope, comuneIstat: string | null, linkZona: string | null,
): Promise<OmiZonaOut> {
  if (!scope.isInVeneto) {
    return {
      available: false, comune: scope.comune, provincia: scope.provincia,
      microzona: null, fascia: null,
      valoreMin: null, valoreMax: null, valoreMedio: null,
      sourceAnchor: "OMI: coperto solo per il Veneto in questa fase.",
      quality: "mancante",
    };
  }
  const omi = await fetchOmiValori(linkZona, comuneIstat);
  if (!omi) {
    return {
      available: false, comune: scope.comune, provincia: scope.provincia,
      microzona: null, fascia: null,
      valoreMin: null, valoreMax: null, valoreMedio: null,
      sourceAnchor: "OMI: dato reale non disponibile per la microzona richiesta.",
      quality: "mancante",
    };
  }
  const min = omi.min ?? null;
  const max = omi.max ?? null;
  const med = (min != null && max != null) ? Math.round((min + max) / 2) : null;
  return {
    available: true, comune: scope.comune, provincia: scope.provincia,
    microzona: linkZona, fascia: omi.fascia,
    valoreMin: min, valoreMax: max, valoreMedio: med,
    sourceAnchor: linkZona
      ? `Agenzia delle Entrate — OMI microzona ${linkZona}.`
      : "Agenzia delle Entrate — OMI comunale.",
    quality: "reale",
  };
}

export async function buildCompetizioneAttiva(scope: VenetoScope): Promise<CompetizioneAttiva> {
  if (!scope.isInVeneto || (!scope.provincia && !scope.comune)) {
    return {
      available: false, annunciAttiviStimati: null, ribassiUltimoMese: null,
      asteVicine: null, pressioneCompetitiva: "sconosciuta",
      note: "Competizione: dato non disponibile fuori Veneto o senza provincia/comune.",
    };
  }
  const { active, ribassi } = await countCompetition(scope.provincia, scope.comune);
  let pressione: CompetizioneAttiva["pressioneCompetitiva"] = "sconosciuta";
  if (active != null) {
    if (active >= 80) pressione = "alta";
    else if (active >= 25) pressione = "media";
    else pressione = "bassa";
  }
  return {
    available: active != null || ribassi != null,
    annunciAttiviStimati: active,
    ribassiUltimoMese: ribassi,
    asteVicine: null, // placeholder — non incluso nel dataset attuale
    pressioneCompetitiva: pressione,
    note: active == null
      ? "Conteggio annunci non disponibile: dataset portali in popolamento."
      : `Annunci attivi ultimi 30gg: ${active}. Ribassi attivi: ${ribassi ?? "n/d"}.`,
  };
}

export function enrichImmobile(
  input: EnrichInput,
  scope: VenetoScope,
  omi: OmiZonaOut,
  comp: CompetizioneAttiva,
): ImmobileEnrichment {
  return {
    tipologiaPresunta: deriveTipologia(input.facts),
    statoApparente: deriveStato(input.facts),
    puntiForti: derivePuntiForti(input, scope, omi),
    criticitaVisibili: deriveCriticita(input, omi, comp),
    provincia: scope.provincia,
    comune: scope.comune,
  };
}

export function buildArgomentoEsclusiva(
  scope: VenetoScope, omi: OmiZonaOut, comp: CompetizioneAttiva,
  enrich: ImmobileEnrichment,
): { argomento: string; motivi: string[]; obiezioni: Array<{ obiezione: string; risposta: string }> } {
  const where = scope.comune
    ? `${scope.comune}${scope.provincia ? ` (${scope.provincia})` : ""}`
    : (scope.provincia ?? "zona");
  const omiTxt = omi.available && omi.valoreMin && omi.valoreMax
    ? `i valori OMI ufficiali ${omi.valoreMin}-${omi.valoreMax} €/m²${omi.microzona ? ` (microzona ${omi.microzona})` : ""}`
    : "i Riferimenti di Mercato disponibili";
  const presTxt = comp.pressioneCompetitiva === "alta"
    ? "in un contesto con pressione competitiva ALTA"
    : comp.pressioneCompetitiva === "media"
      ? "in un contesto con pressione competitiva media"
      : comp.pressioneCompetitiva === "bassa"
        ? "in un contesto con pressione competitiva contenuta"
        : "con la competizione di zona da monitorare";
  const forte = enrich.puntiForti[0] ? ` Punto forte da capitalizzare: ${enrich.puntiForti[0]}` : "";
  const critico = enrich.criticitaVisibili[0] ? ` Punto da gestire: ${enrich.criticitaVisibili[0]}` : "";

  const argomento =
    `In ${where}, l'Incarico in Esclusiva consente di posizionare l'immobile usando ${omiTxt}, ` +
    `${presTxt}, evitando il rischio di un prezzo non validato e di pubblicazioni multiple incoerenti.${forte}${critico}`;

  const motivi: string[] = [];
  if (omi.available) motivi.push(`Posizionamento ancorato a OMI ufficiali (${omi.valoreMin ?? "?"}-${omi.valoreMax ?? "?"} €/m²).`);
  if (comp.pressioneCompetitiva === "alta") motivi.push("La pressione competitiva alta richiede una strategia coordinata da una sola agenzia.");
  if (comp.ribassiUltimoMese && comp.ribassiUltimoMese > 0) motivi.push("I ribassi attivi in zona dimostrano il rischio di partire con un prezzo non validato.");
  if (enrich.puntiForti.length > 0) motivi.push("I punti forti dell'immobile vanno presentati con materiali coerenti, non dispersi.");
  if (enrich.criticitaVisibili.length > 0) motivi.push("Le criticità rilevate vanno gestite con un piano commerciale unico, non improvvisato.");
  if (motivi.length < 3) {
    motivi.push("L'esclusiva permette di concentrare risorse su un solo posizionamento coerente.");
    motivi.push("Senza esclusiva il valore percepito si disperde tra annunci diversi nello stesso giorno.");
  }

  const obiezioni: Array<{ obiezione: string; risposta: string }> = [
    {
      obiezione: "Voglio provarci da solo.",
      risposta: "Comprensibile: l'esclusiva non toglie la possibilità di vendere a un suo contatto. Definiamolo per iscritto.",
    },
    {
      obiezione: "Non voglio vincoli.",
      risposta: "L'esclusiva è un metodo, non una gabbia: serve a proteggere il valore percepito nei primi 30 giorni di pubblicazione.",
    },
    {
      obiezione: "Un'altra agenzia mi ha promesso un prezzo più alto.",
      risposta: omi.available
        ? `I valori OMI ufficiali parlano chiaro (${omi.valoreMin ?? "?"}-${omi.valoreMax ?? "?"} €/m²). Una promessa non è un prezzo validato.`
        : "Una promessa non è un prezzo validato. Le mostro come arriviamo al prezzo con i comparabili reali.",
    },
    {
      obiezione: "Non voglio abbassare il prezzo.",
      risposta: "L'obiettivo non è abbassare ma partire al prezzo corretto: i ribassi successivi bruciano l'immobile.",
    },
  ];

  return { argomento, motivi, obiezioni };
}

export function buildDataQuality(
  scope: VenetoScope, omi: OmiZonaOut, comp: CompetizioneAttiva,
  input: EnrichInput,
): DataQuality {
  const real: string[] = [];
  const estimated: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];

  if (scope.isInVeneto && scope.confidence >= 0.9) real.push("venetoScope");
  else if (scope.isInVeneto) estimated.push("venetoScope");
  else missing.push("venetoScope");

  if (omi.quality === "reale") real.push("omiZona");
  else if (omi.quality === "stimato") estimated.push("omiZona");
  else missing.push("omiZona");

  if (comp.available) real.push("competizioneAttiva");
  else missing.push("competizioneAttiva");

  if (input.coords) real.push("geo");
  else missing.push("geo");

  if (input.hasUsablePhoto) real.push("photo");
  else warnings.push("Foto non utilizzabile: alcune valutazioni visive non sono possibili.");

  if (!scope.isInVeneto) warnings.push("Dataset Veneto non applicabile fuori regione: campi marcati come mancanti.");
  if (!omi.available) warnings.push("OMI non disponibile per la microzona: usare con cautela in negoziazione.");

  return { real, estimated, missing, warnings };
}

export interface VenetoEnrichmentBundle {
  venetoScope: VenetoScope;
  omiZona: OmiZonaOut;
  competizioneAttiva: CompetizioneAttiva;
  immobileExtras: ImmobileEnrichment;
  esclusivaExtras: ReturnType<typeof buildArgomentoEsclusiva>;
  dataQuality: DataQuality;
}

export async function buildVenetoEnrichment(input: EnrichInput): Promise<VenetoEnrichmentBundle> {
  const safeInput: EnrichInput = {
    coords: input.coords ?? null,
    manualAddress: input.manualAddress ?? "",
    hasUsablePhoto: !!input.hasUsablePhoto,
    facts: input.facts ?? {},
  };
  const { scope, comuneIstat, linkZona } = await buildVenetoScope(safeInput);
  const [omiZona, competizioneAttiva] = await Promise.all([
    buildOmiZona(scope, comuneIstat, linkZona),
    buildCompetizioneAttiva(scope),
  ]);
  const immobileExtras = enrichImmobile(safeInput, scope, omiZona, competizioneAttiva);
  const esclusivaExtras = buildArgomentoEsclusiva(scope, omiZona, competizioneAttiva, immobileExtras);
  const dataQuality = buildDataQuality(scope, omiZona, competizioneAttiva, safeInput);
  return { venetoScope: scope, omiZona, competizioneAttiva, immobileExtras, esclusivaExtras, dataQuality };
}

export { clamp01 };
