import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  aggregateDiagnostics,
  httpFailureCode,
  isOperationalFailure,
  parseExtractionContent,
  shouldTryPlainJsonFallback,
  validateExtraction,
  type ExtractionFailureCode,
  type ExtractionOutcome,
} from "./extraction.ts";



type JsonObject = Record<string, unknown>;

type CompanyProfile = {
  forma_giuridica?: string;
  codice_ateco?: string;
  ateco_secondari?: string[];
  regione?: string;
  provincia?: string;
  comune?: string;
  numero_dipendenti?: number;
  fatturato_annuo?: number;
  anno_costituzione?: number;
  imprenditoria_femminile?: boolean;
  impresa_giovanile?: boolean;
  startup_innovativa?: boolean;
  pmi_innovativa?: boolean;
  dimensione_impresa?: string;
  investimenti_previsti?: string[];
  spesa_prevista?: number;
  de_minimis_ultimi_3_anni?: number;
  impresa_in_difficolta?: boolean;
  paese_sede?: string;
  disponibile_consorzio_europeo?: boolean;
};

type Source = {
  id: string;
  name: string;
  authority_level: string;
  region: string | null;
  province: string | null;
  official_domain: string;
  search_query: string;
  source_kind: string;
  rarity_base: number;
  fast_lane: boolean;
  scan_interval_minutes: number;
};

type SearchHit = { url: string; title: string; description: string; provider: string };

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const ALLOWED_ACTIONS = new Set([
  "feed",
  "request_refresh",
  "collect",
  "maintenance",
  "release_gate",
  "status",
]);

const extractionSchema = {
  type: "json_schema",
  json_schema: {
    name: "trovabandi_opportunity",
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "is_opportunity",
        "title",
        "authority_name",
        "category",
        "summary",
        "official_url",
        "requirements",
      ],
      properties: {
        is_opportunity: { type: "boolean" },
        title: { type: "string" },
        authority_name: { type: "string" },
        category: {
          type: "string",
          enum: [
            "FONDO_PERDUTO",
            "FINANZIAMENTO_AGEVOLATO",
            "TASSO_ZERO",
            "CREDITO_IMPOSTA",
            "GARANZIA",
            "VOUCHER",
            "IMPRENDITORIA_FEMMINILE",
            "IMPRENDITORIA_GIOVANILE",
            "DIGITALIZZAZIONE",
            "TRANSIZIONE_ENERGETICA",
            "RICERCA_SVILUPPO",
            "INTERNAZIONALIZZAZIONE",
            "STARTUP_INNOVAZIONE",
            "FORMAZIONE_OCCUPAZIONE",
            "AGRICOLTURA_RURALE",
            "TURISMO_CULTURA",
            "ECONOMIA_CIRCOLARE",
            "ALTRO",
          ],
        },
        summary: { type: "string" },
        official_url: { type: "string" },
        notice_url: { type: ["string", "null"] },
        application_url: { type: ["string", "null"] },
        forms_url: { type: ["string", "null"] },
        protocol_email: { type: ["string", "null"] },
        region: { type: ["string", "null"] },
        province: { type: ["string", "null"] },
        municipality: { type: ["string", "null"] },
        eligible_ateco_prefixes: { type: "array", items: { type: "string" } },
        excluded_ateco_prefixes: { type: "array", items: { type: "string" } },
        eligible_legal_forms: { type: "array", items: { type: "string" } },
        eligible_company_sizes: { type: "array", items: { type: "string" } },
        female_only: { type: "boolean" },
        youth_only: { type: "boolean" },
        startup_only: { type: "boolean" },
        innovative_only: { type: "boolean" },
        de_minimis: { type: ["boolean", "null"] },
        aid_intensity_percent: { type: ["number", "null"] },
        min_grant_amount: { type: ["number", "null"] },
        max_grant_amount: { type: ["number", "null"] },
        total_budget: { type: ["number", "null"] },
        opens_at: { type: ["string", "null"] },
        deadline_at: { type: ["string", "null"] },
        click_day: { type: "boolean" },
        requirements: { type: "array", items: { type: "string" } },
        eligible_expenses: { type: "array", items: { type: "string" } },
        publication_reference: { type: ["string", "null"] },
        programme_name: { type: ["string", "null"] },
        programme_code: { type: ["string", "null"] },
        pnrr_mission: { type: ["string", "null"] },
        pnrr_component: { type: ["string", "null"] },
        implementing_body: { type: ["string", "null"] },
        eligible_countries: { type: "array", items: { type: "string" } },
        consortium_required: { type: ["boolean", "null"] },
        min_partners: { type: ["integer", "null"] },
        direct_applicant_allowed: { type: ["boolean", "null"] },
      },
    },
  },
};

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function env(name: string) {
  return Deno.env.get(name)?.trim() ?? "";
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCode(value: unknown): string {
  return normalizeText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeUrl(value: unknown): string | null {
  try {
    const u = new URL(normalizeText(value));
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return null;
  }
}

function hostMatches(url: string, domain: string) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const allowed = domain.toLowerCase().replace(/^www\./, "");
    return host === allowed || host.endsWith(`.${allowed}`);
  } catch {
    return false;
  }
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function safeSecretEqual(left: string, right: string) {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isoOrNull(value: unknown): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateIsPresentInEvidence(markdown: string, iso: string | null) {
  if (!iso) return false;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const day = date.getUTCDate();
  const dd = String(day).padStart(2, "0");
  const month = date.getUTCMonth() + 1;
  const mm = String(month).padStart(2, "0");
  const year = date.getUTCFullYear();
  const monthNames = [
    "gennaio",
    "febbraio",
    "marzo",
    "aprile",
    "maggio",
    "giugno",
    "luglio",
    "agosto",
    "settembre",
    "ottobre",
    "novembre",
    "dicembre",
  ];
  const normalized = markdown.toLowerCase();
  return [
    `${year}-${mm}-${dd}`,
    `${dd}/${mm}/${year}`,
    `${day}/${month}/${year}`,
    `${dd}-${mm}-${year}`,
    `${day} ${monthNames[month - 1]} ${year}`,
  ].some((candidate) => normalized.includes(candidate));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeText).filter(Boolean))].slice(0, 100);
}

function inferCompanySize(profile: CompanyProfile) {
  if (profile.dimensione_impresa) return normalizeCode(profile.dimensione_impresa);
  const employees = Number(profile.numero_dipendenti ?? 0);
  const revenue = Number(profile.fatturato_annuo ?? 0);
  if (employees < 10 && revenue <= 2_000_000) return "MICRO";
  if (employees < 50 && revenue <= 10_000_000) return "PICCOLA";
  if (employees < 250 && revenue <= 50_000_000) return "MEDIA";
  return "GRANDE";
}

function matchOpportunity(opportunity: JsonObject, profile: CompanyProfile) {
  const confirmed: string[] = [];
  const missing: string[] = [];
  const blockers: string[] = [];
  const level = normalizeCode(opportunity.authority_level);
  const region = normalizeCode(opportunity.region);
  const province = normalizeCode(opportunity.province);
  const profileRegion = normalizeCode(profile.regione);
  const profileProvince = normalizeCode(profile.provincia);

  if (level === "REGIONALE" && region) {
    if (region === profileRegion) confirmed.push("Sede nella regione ammessa");
    else blockers.push("Regione non ammessa");
  } else if ((level === "CAMERALE" || level === "COMUNALE") && province) {
    if (province === profileProvince) confirmed.push("Sede nella provincia ammessa");
    else blockers.push("Provincia non ammessa");
  } else {
    confirmed.push("Ambito territoriale compatibile");
  }

  if (level === "EU") {
    const countries = stringArray(opportunity.eligible_countries).map(normalizeCode);
    const country = normalizeCode(profile.paese_sede || "IT");
    const italyAliases = new Set(["IT", "ITA", "ITALIA", "ITALY"]);
    const admitsItaly = countries.some(
      (item) =>
        italyAliases.has(item) || item === "EU" || item === "UE" || item === "ALLEUMEMBERSTATES",
    );
    if (countries.length === 0) missing.push("Ammissibilità dell'Italia da verificare");
    else if (admitsItaly || countries.includes(country))
      confirmed.push("Italia tra i Paesi ammissibili");
    else blockers.push("Italia non indicata tra i Paesi ammissibili");
    if (opportunity.consortium_required === true) {
      if (profile.disponibile_consorzio_europeo) confirmed.push("Disponibilità al partenariato UE");
      else missing.push("Partenariato o consorzio europeo richiesto");
    }
  }

  const atecos = [profile.codice_ateco, ...(profile.ateco_secondari ?? [])]
    .map(normalizeCode)
    .filter(Boolean);
  const included = stringArray(opportunity.eligible_ateco_prefixes).map(normalizeCode);
  const excluded = stringArray(opportunity.excluded_ateco_prefixes).map(normalizeCode);
  if (excluded.some((prefix) => atecos.some((ateco) => ateco.startsWith(prefix))))
    blockers.push("Codice ATECO escluso");
  else if (included.length === 0) missing.push("ATECO da verificare nel testo ufficiale");
  else if (included.some((prefix) => atecos.some((ateco) => ateco.startsWith(prefix))))
    confirmed.push("Codice ATECO ammesso");
  else blockers.push("Codice ATECO non compreso");

  const forms = stringArray(opportunity.eligible_legal_forms).map(normalizeCode);
  if (forms.length === 0) missing.push("Forma giuridica da verificare");
  else if (forms.includes(normalizeCode(profile.forma_giuridica)))
    confirmed.push("Forma giuridica ammessa");
  else blockers.push("Forma giuridica non ammessa");

  const sizes = stringArray(opportunity.eligible_company_sizes).map(normalizeCode);
  if (sizes.length === 0) missing.push("Dimensione impresa da verificare");
  else if (sizes.includes(inferCompanySize(profile))) confirmed.push("Dimensione impresa ammessa");
  else blockers.push("Dimensione impresa non ammessa");

  if (opportunity.female_only === true && !profile.imprenditoria_femminile)
    blockers.push("Riservato a imprese femminili");
  if (opportunity.youth_only === true && !profile.impresa_giovanile)
    blockers.push("Riservato a imprese giovanili");
  if (opportunity.startup_only === true && !profile.startup_innovativa)
    blockers.push("Riservato a startup innovative");
  if (
    opportunity.innovative_only === true &&
    !profile.startup_innovativa &&
    !profile.pmi_innovativa
  )
    blockers.push("Requisito impresa innovativa non presente");
  if (opportunity.de_minimis === true && profile.de_minimis_ultimi_3_anni == null)
    missing.push("Plafond de minimis da verificare");
  if (profile.impresa_in_difficolta) missing.push("Verificare esclusione impresa in difficoltà");

  const verified = normalizeCode(opportunity.verification_status) === "VERIFICATO";
  const status =
    blockers.length > 0
      ? "NON_COMPATIBILE"
      : missing.length === 0 && verified
        ? "COMPATIBILE"
        : "DA_VERIFICARE";
  const score =
    blockers.length > 0
      ? 0
      : Math.max(
          35,
          Math.min(100, 45 + confirmed.length * 11 - missing.length * 5 + (verified ? 10 : 0)),
        );
  return { status, score, confirmed, missing, blockers };
}

async function firecrawlSearch(source: Source): Promise<SearchHit[]> {
  const key = env("FIRECRAWL_API_KEY");
  if (!key) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: source.search_query,
        includeDomains: [source.official_domain],
        limit: 8,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as JsonObject;
    const data = payload.data as JsonObject | unknown[] | undefined;
    const rows = Array.isArray(data)
      ? data
      : Array.isArray((data as JsonObject | undefined)?.web)
        ? ((data as JsonObject).web as unknown[])
        : [];
    return rows.flatMap((row): SearchHit[] => {
      const item = row as JsonObject;
      const url = normalizeUrl(item.url);
      return url && hostMatches(url, source.official_domain)
        ? [
            {
              url,
              title: normalizeText(item.title),
              description: normalizeText(item.description),
              provider: "firecrawl",
            },
          ]
        : [];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function perplexitySearch(source: Source): Promise<SearchHit[]> {
  const key = env("PERPLEXITY_API_KEY");
  if (!key) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch("https://api.perplexity.ai/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: source.search_query,
        search_domain_filter: [source.official_domain],
        max_results: 8,
        max_tokens_per_page: 512,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as JsonObject;
    const rows = Array.isArray(payload.results) ? payload.results : [];
    return rows.flatMap((row): SearchHit[] => {
      const item = row as JsonObject;
      const url = normalizeUrl(item.url);
      return url && hostMatches(url, source.official_domain)
        ? [
            {
              url,
              title: normalizeText(item.title),
              description: normalizeText(item.snippet),
              provider: "perplexity",
            },
          ]
        : [];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function scrapePage(
  url: string,
): Promise<{ markdown: string; title: string; provider: string } | null> {
  const key = env("FIRECRAWL_API_KEY");
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        maxAge: 21_600_000,
        timeout: 20_000,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as JsonObject;
    const data = (payload.data ?? payload) as JsonObject;
    const markdown = normalizeText(data.markdown).slice(0, 60_000);
    const metadata = (data.metadata ?? {}) as JsonObject;
    return markdown.length > 200
      ? { markdown, title: normalizeText(metadata.title), provider: "firecrawl" }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function apifyScrape(
  url: string,
): Promise<{ markdown: string; title: string; provider: string } | null> {
  const token = env("APIFY_TOKEN");
  if (!token) return null;
  const actor = env("TROVABANDI_APIFY_ACTOR_ID") || "apify~website-content-crawler";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55_000);
  try {
    const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=50&memory=512`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startUrls: [{ url }],
        maxCrawlPages: 1,
        crawlerType: "playwright:adaptive",
        saveMarkdown: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as JsonObject[];
    const item = rows[0] ?? {};
    const markdown = normalizeText(item.markdown || item.text || item.content).slice(0, 60_000);
    return markdown.length > 200
      ? { markdown, title: normalizeText(item.title), provider: "apify" }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadPage(url: string) {
  return (await scrapePage(url)) ?? (await apifyScrape(url));
}

async function callExtraction(
  key: string,
  model: string,
  prompt: string,
  useSchema: boolean,
): Promise<{ ok: true; content: string } | { ok: false; code: ExtractionFailureCode }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: useSchema
              ? "Sei un estrattore documentale prudente per bandi pubblici italiani, PNRR e programmi UE. Il testo fornito è l'unica autorità."
              : "Sei un estrattore documentale prudente per bandi pubblici italiani, PNRR e programmi UE. Il testo fornito è l'unica autorità. Rispondi esclusivamente con un singolo oggetto JSON valido, senza testo aggiuntivo e senza blocchi di codice.",
          },
          { role: "user", content: prompt },
        ],
        ...(useSchema ? { response_format: extractionSchema } : {}),
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Il corpo non viene letto né registrato: solo la classe HTTP sanificata.
      await res.body?.cancel();
      return { ok: false, code: httpFailureCode(res.status) };
    }
    const payload = (await res.json()) as JsonObject;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const message = ((choices[0] as JsonObject | undefined)?.message ?? {}) as JsonObject;
    return { ok: true, content: normalizeText(message.content) };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "HTTP_ERROR",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function extractOpportunity(
  source: Source,
  hit: SearchHit,
  markdown: string,
): Promise<ExtractionOutcome> {
  const key = env("PERPLEXITY_API_KEY");
  if (!key) return { ok: false, code: "NO_KEY" };
  const model = env("TROVABANDI_PERPLEXITY_MODEL") || "sonar-pro";
  const schemaHint = `Campi ammessi: is_opportunity (boolean), title, authority_name, category (uno tra FONDO_PERDUTO, FINANZIAMENTO_AGEVOLATO, TASSO_ZERO, CREDITO_IMPOSTA, GARANZIA, VOUCHER, IMPRENDITORIA_FEMMINILE, IMPRENDITORIA_GIOVANILE, DIGITALIZZAZIONE, TRANSIZIONE_ENERGETICA, RICERCA_SVILUPPO, INTERNAZIONALIZZAZIONE, STARTUP_INNOVAZIONE, FORMAZIONE_OCCUPAZIONE, AGRICOLTURA_RURALE, TURISMO_CULTURA, ECONOMIA_CIRCOLARE, ALTRO), summary, official_url, notice_url, application_url, forms_url, protocol_email, region, province, municipality, eligible_ateco_prefixes[], excluded_ateco_prefixes[], eligible_legal_forms[], eligible_company_sizes[], female_only, youth_only, startup_only, innovative_only, de_minimis, aid_intensity_percent, min_grant_amount, max_grant_amount, total_budget, opens_at, deadline_at, click_day, requirements[], eligible_expenses[], publication_reference, programme_name, programme_code, pnrr_mission, pnrr_component, implementing_body, eligible_countries[], consortium_required, min_partners, direct_applicant_allowed.`;
  const prompt = `Estrai esclusivamente dati presenti nel testo ufficiale seguente. Non dedurre requisiti, date o importi mancanti. Se la pagina non descrive un bando, incentivo o finanziamento per imprese aperto, in apertura o con documentazione ancora rilevante, imposta is_opportunity=false. official_url deve essere ${hit.url}. Date ISO 8601. Prefissi ATECO senza punteggiatura superflua. Per opportunità UE estrai programma, codice call/topic, Paesi ammessi e obbligo/minimo partner. Per PNRR estrai Missione, Componente e soggetto attuatore soltanto se espliciti.\n${schemaHint}\n\n${markdown}`;

  // Massimo due tentativi: schema JSON, poi eventuale fallback plain JSON.
  const modes: Array<"json_schema" | "json_fallback"> = ["json_schema", "json_fallback"];
  let lastFailure: ExtractionOutcome = { ok: false, code: "UNKNOWN" };
  for (const mode of modes) {
    const call = await callExtraction(key, model, prompt, mode === "json_schema");
    if (!call.ok) {
      lastFailure = { ok: false, code: call.code, mode };
      // Nessun retry su 401/402/403/429/5xx/timeout: sono errori operativi.
      if (!shouldTryPlainJsonFallback(call.code)) return lastFailure;
      continue;
    }
    const parsed = parseExtractionContent(call.content);
    if (!parsed.ok) {
      lastFailure = { ok: false, code: parsed.code, mode };
      if (!shouldTryPlainJsonFallback(parsed.code)) return lastFailure;
      continue;
    }
    const validated = validateExtraction(parsed.value, source.official_domain, hit.url);
    if (!validated.ok) {
      // Contenuto leggibile ma non ammissibile: fail-closed, nessun retry.
      return { ok: false, code: validated.code, mode };
    }
    return { ok: true, data: validated.data, mode };
  }
  return lastFailure;
}




async function storeOpportunity(
  sb: ReturnType<typeof createClient>,
  source: Source,
  hit: SearchHit,
  extracted: JsonObject,
  markdown: string,
  extractionProvider: string,
): Promise<{ stored: boolean; verified: boolean; code: string }> {
  const officialUrl = normalizeUrl(hit.url);
  if (!officialUrl || !hostMatches(officialUrl, source.official_domain))
    return { stored: false, verified: false, code: "OFF_DOMAIN" };

  const deadline = isoOrNull(extracted.deadline_at);
  const now = new Date();
  const expired = deadline ? new Date(deadline).getTime() < now.getTime() : false;
  const hasEvidence = markdown.length > 200 && source.official_domain.length > 3;
  const deadlineProven = dateIsPresentInEvidence(markdown, deadline);
  const verification =
    expired && deadlineProven
      ? "SCADUTO"
      : hasEvidence && deadline && deadlineProven
        ? "VERIFICATO"
        : hasEvidence
          ? "PARZIALE"
          : "DA_VERIFICARE";
  const contentHash = await sha256(markdown);
  const canonicalKey = await sha256(officialUrl.toLowerCase());
  const discoveredBy = safeTextArray([
    ...new Set(hit.provider.split("+").concat(extractionProvider, "perplexity")),
  ]);
  // I valori vincolati da CHECK non possono essere inventati: se non sono
  // ammessi si degrada in modo conservativo (categoria ALTRO) o si rifiuta.
  const category = normalizeCategoryCode(extracted.category) ?? "ALTRO";
  const authorityLevel = normalizeAuthorityLevel(source.authority_level);
  if (!authorityLevel) return { stored: false, verified: false, code: "AUTHORITY_LEVEL_INVALID" };
  const row = {
    canonical_key: canonicalKey,
    title: normalizeText(extracted.title).slice(0, 500) || hit.title || "Opportunità senza titolo",
    authority_name: normalizeText(extracted.authority_name).slice(0, 300) || source.name,
    authority_level: authorityLevel,
    category,
    summary:
      normalizeText(extracted.summary).slice(0, 5000) ||
      hit.description ||
      "Dettagli nella fonte ufficiale.",
    official_url: officialUrl,
    notice_url: normalizeUrl(extracted.notice_url),
    application_url: normalizeUrl(extracted.application_url),
    forms_url: normalizeUrl(extracted.forms_url),
    protocol_email: normalizeText(extracted.protocol_email).slice(0, 320) || null,
    region: normalizeText(extracted.region).slice(0, 120) || source.region,
    province: normalizeText(extracted.province).slice(0, 120) || source.province,
    municipality: normalizeText(extracted.municipality).slice(0, 120) || null,
    eligible_ateco_prefixes: safeTextArray(extracted.eligible_ateco_prefixes),
    excluded_ateco_prefixes: safeTextArray(extracted.excluded_ateco_prefixes),
    eligible_legal_forms: safeTextArray(extracted.eligible_legal_forms),
    eligible_company_sizes: safeTextArray(extracted.eligible_company_sizes),
    female_only: extracted.female_only === true,
    youth_only: extracted.youth_only === true,
    startup_only: extracted.startup_only === true,
    innovative_only: extracted.innovative_only === true,
    de_minimis: typeof extracted.de_minimis === "boolean" ? extracted.de_minimis : null,
    // numeric(6,2) / numeric(15,2) / numeric(18,2): overflow ⇒ dato assente.
    aid_intensity_percent: boundedNumeric(extracted.aid_intensity_percent, 6, 2),
    min_grant_amount: boundedNumeric(extracted.min_grant_amount, 15, 2),
    max_grant_amount: boundedNumeric(extracted.max_grant_amount, 15, 2),
    total_budget: boundedNumeric(extracted.total_budget, 18, 2),
    opens_at: safeTimestamp(extracted.opens_at),
    deadline_at: deadline,
    click_day: extracted.click_day === true,
    requirements: safeTextArray(extracted.requirements, 100, 1000),
    eligible_expenses: safeTextArray(extracted.eligible_expenses, 100, 1000),
    verification_status: verification,
    rarity_score: boundedInteger(Math.trunc(Number(source.rarity_base ?? 1)), 1, 5) ?? 1,
    source_kind: normalizeText(source.source_kind).slice(0, 60) || "CATALOGO",
    publication_reference: normalizeText(extracted.publication_reference).slice(0, 300) || null,
    programme_name: normalizeText(extracted.programme_name).slice(0, 300) || null,
    programme_code: normalizeText(extracted.programme_code).slice(0, 120) || null,
    pnrr_mission: normalizeText(extracted.pnrr_mission).slice(0, 120) || null,
    pnrr_component: normalizeText(extracted.pnrr_component).slice(0, 120) || null,
    implementing_body: normalizeText(extracted.implementing_body).slice(0, 300) || null,
    eligible_countries: safeTextArray(extracted.eligible_countries),
    consortium_required:
      typeof extracted.consortium_required === "boolean" ? extracted.consortium_required : null,
    min_partners: boundedInteger(extracted.min_partners, 0, 2_147_483_647),
    direct_applicant_allowed:
      typeof extracted.direct_applicant_allowed === "boolean"
        ? extracted.direct_applicant_allowed
        : null,
    official_source: true,
    discovered_by: discoveredBy,
    content_hash: contentHash,
    raw_excerpt: markdown.slice(0, 4000),
    last_seen_at: now.toISOString(),
    // last_verified_at è valorizzato soltanto quando la verifica è completa.
    last_verified_at: verification === "VERIFICATO" ? now.toISOString() : null,
    updated_at: now.toISOString(),
  };
  const { data, error } = await sb
    .from("trovabandi_opportunities")
    .upsert(row, { onConflict: "official_url" })
    .select("id")
    .single();
  if (error || !data) {
    // Telemetria sicura: soltanto il codice sanificato dell'errore di scrittura.
    return {
      stored: false,
      verified: false,
      code: `OPPORTUNITY_WRITE_FAILED_${error ? sanitizeDbErrorCode(error) : "DB_NO_ROW"}`,
    };
  }
  const { error: evidenceError } = await sb.from("trovabandi_evidence").upsert(
    {
      opportunity_id: data.id,
      source_url: officialUrl,
      source_title: (hit.title || row.title).slice(0, 500),
      evidence_type: officialUrl.toLowerCase().includes(".pdf") ? "PDF" : "OFFICIAL_PAGE",
      excerpt: markdown.slice(0, 3000),
      fetched_at: now.toISOString(),
      content_hash: contentHash,
    },
    { onConflict: "opportunity_id,source_url" },
  );
  if (evidenceError) {
    // Fail-closed: senza prova persistita l'opportunità non può risultare verificata.
    // Compensazione non distruttiva: si declassa lo stato, non si cancella nulla.
    await sb
      .from("trovabandi_opportunities")
      .update({
        verification_status: "DA_VERIFICARE",
        last_verified_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    return {
      stored: false,
      verified: false,
      code: `EVIDENCE_WRITE_FAILED_${sanitizeDbErrorCode(evidenceError)}`,
    };
  }

  return {
    stored: true,
    verified: verification === "VERIFICATO",
    code: verification === "VERIFICATO" ? "OK_VERIFICATO" : `OK_${verification}`,
  };
}


serve(async (req) => {
  if (req.method === "OPTIONS") return response(204, {});
  if (req.method !== "POST") return response(405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  if (req.headers.get("origin")) return response(403, { ok: false, code: "SERVER_TO_SERVER_ONLY" });
  const secret = env("AI_CORE_SECRET_TROVABANDI");
  const supplied = req.headers.get("x-internal-secret") ?? "";
  if (!secret) return response(503, { ok: false, code: "AUTH_NOT_CONFIGURED" });
  if (!(await safeSecretEqual(secret, supplied)))
    return response(401, { ok: false, code: "UNAUTHORIZED" });

  let body: JsonObject;
  try {
    body = await req.json();
  } catch {
    return response(400, { ok: false, code: "INVALID_JSON" });
  }
  const action = normalizeText(body.action || "feed");
  if (!ALLOWED_ACTIONS.has(action)) return response(400, { ok: false, code: "INVALID_ACTION" });

  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

  if (action === "status") {
    const [{ count: active }, { data: run }] = await Promise.all([
      sb
        .from("trovabandi_opportunities")
        .select("id", { count: "exact", head: true })
        .in("verification_status", ["VERIFICATO", "PARZIALE"]),
      sb
        .from("trovabandi_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    return response(200, {
      ok: true,
      active: active ?? 0,
      last_run: run ?? null,
      providers: {
        firecrawl: !!env("FIRECRAWL_API_KEY"),
        perplexity: !!env("PERPLEXITY_API_KEY"),
        apify: !!env("APIFY_TOKEN"),
      },
    });
  }

  if (action === "maintenance") {
    const now = new Date().toISOString();
    const { count, error } = await sb
      .from("trovabandi_opportunities")
      .update({ verification_status: "SCADUTO", updated_at: now }, { count: "exact" })
      .lt("deadline_at", now)
      .neq("verification_status", "SCADUTO");
    if (error) return response(500, { ok: false, code: "MAINTENANCE_FAILED" });
    return response(200, { ok: true, expired: count ?? 0 });
  }

  if (action === "release_gate") {
    const nowIso = new Date().toISOString();
    const since = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    // Gate fail-closed: PARZIALE, PARTIAL, RUNNING e FAILED non contano mai.
    const [
      { count: verifiedActive },
      { count: partialActive },
      { count: recentVerifiedRuns },
      { count: deepSuccessfulRuns },
    ] = await Promise.all([
      sb
        .from("trovabandi_opportunities")
        .select("id", { count: "exact", head: true })
        .eq("verification_status", "VERIFICATO")
        .eq("official_source", true)
        .or(`deadline_at.is.null,deadline_at.gte.${nowIso}`),
      sb
        .from("trovabandi_opportunities")
        .select("id", { count: "exact", head: true })
        .eq("verification_status", "PARZIALE"),
      sb
        .from("trovabandi_runs")
        .select("id", { count: "exact", head: true })
        .gte("started_at", since)
        .eq("status", "SUCCEEDED")
        .not("finished_at", "is", null)
        .gt("verified_count", 0),
      sb
        .from("trovabandi_runs")
        .select("id,trovabandi_sources!inner(source_kind)", { count: "exact", head: true })
        .gte("started_at", since)
        .eq("status", "SUCCEEDED")
        .not("finished_at", "is", null)
        .in("trovabandi_sources.source_kind", ["BUR", "ALBO_PRETORIO", "CAMERALE", "GAL"]),
    ]);
    const metrics = {
      verified_active: verifiedActive ?? 0,
      partial_active: partialActive ?? 0,
      recent_verified_runs: recentVerifiedRuns ?? 0,
      deep_successful_runs: deepSuccessfulRuns ?? 0,
    };
    const checks = {
      verified_catalogue: metrics.verified_active > 0,
      recent_verified_runs: metrics.recent_verified_runs > 0,
      deep_sources_verified_scan: metrics.deep_successful_runs > 0,
    };
    const ok = Object.values(checks).every(Boolean);
    return response(ok ? 200 : 409, {
      ok,
      gate_passed: ok,
      cron_activation_allowed: ok,
      checks,
      metrics,
    });
  }


  if (action === "request_refresh") {
    const profile = (body.profile ?? {}) as CompanyProfile;
    const interests = stringArray(profile.investimenti_previsti).map(normalizeCode);
    const requestKey = await sha256(
      [
        normalizeCode(profile.regione),
        normalizeCode(profile.provincia),
        normalizeCode(profile.codice_ateco).slice(0, 2),
        inferCompanySize(profile),
        profile.imprenditoria_femminile ? "F" : "",
        profile.impresa_giovanile ? "G" : "",
        profile.startup_innovativa || profile.pmi_innovativa ? "I" : "",
        interests.sort().join(","),
      ].join("|"),
    );
    await sb.from("trovabandi_refresh_requests").upsert(
      {
        request_key: requestKey,
        region: normalizeText(profile.regione) || null,
        province: normalizeText(profile.provincia) || null,
        municipality: normalizeText(profile.comune) || null,
        ateco_prefix: normalizeCode(profile.codice_ateco).slice(0, 2) || null,
        company_size: inferCompanySize(profile),
        interest_categories: interests,
        female_business: profile.imprenditoria_femminile === true,
        youth_business: profile.impresa_giovanile === true,
        innovative_business: profile.startup_innovativa === true || profile.pmi_innovativa === true,
        requested_at: new Date().toISOString(),
        processed_at: null,
      },
      { onConflict: "request_key" },
    );
    return response(202, { ok: true, queued: true });
  }

  if (action === "feed") {
    const profile = (body.profile ?? {}) as CompanyProfile;
    if (!normalizeText(profile.regione) || !normalizeText(profile.codice_ateco))
      return response(400, { ok: false, code: "PROFILE_INCOMPLETE" });
    const limit = Math.max(1, Math.min(300, Number(body.limit ?? 200)));
    const { data, error } = await sb
      .from("trovabandi_opportunities")
      .select("*, trovabandi_evidence(source_url,source_title,evidence_type,excerpt,fetched_at)")
      .in("verification_status", ["VERIFICATO", "PARZIALE", "DA_VERIFICARE"])
      .or(`deadline_at.is.null,deadline_at.gte.${new Date().toISOString()}`)
      .order("deadline_at", { ascending: true, nullsFirst: false })
      .limit(limit);
    if (error) return response(500, { ok: false, code: "FEED_QUERY_FAILED" });
    const matched = (data ?? []).map((item) => ({
      ...item,
      match: matchOpportunity(item as JsonObject, profile),
    }));
    const statusRank: Record<string, number> = { COMPATIBILE: 0, DA_VERIFICARE: 1 };
    const visible = matched
      .filter((item) => item.match.status !== "NON_COMPATIBILE")
      .sort((a, b) => {
        const rank = (statusRank[a.match.status] ?? 9) - (statusRank[b.match.status] ?? 9);
        if (rank !== 0) return rank;
        const score = b.match.score - a.match.score;
        if (score !== 0) return score;
        const ad = a.deadline_at ? new Date(a.deadline_at as string).getTime() : Infinity;
        const bd = b.deadline_at ? new Date(b.deadline_at as string).getTime() : Infinity;
        return ad - bd;
      });
    return response(200, {
      ok: true,
      bandi: visible,
      total_considered: matched.length,
      excluded: matched.length - visible.length,
      fetched_at: new Date().toISOString(),
      source: "central-core",
    });
  }

  const sourceId = normalizeText(body.source_id);
  const maxPages = Math.max(1, Math.min(5, Number(body.max_pages ?? 2)));
  const { data: refreshSignal } = sourceId
    ? { data: null }
    : await sb
        .from("trovabandi_refresh_requests")
        .select("*")
        .is("processed_at", null)
        .order("requested_at", { ascending: true })
        .limit(1)
        .maybeSingle();
  let sourceQuery = sb.from("trovabandi_sources").select("*").eq("enabled", true);
  sourceQuery = sourceId
    ? sourceQuery.eq("id", sourceId)
    : sourceQuery
        .lte("next_scan_at", new Date().toISOString())
        .or(
          refreshSignal?.region
            ? `region.is.null,region.eq.${refreshSignal.region}`
            : "region.is.null,region.not.is.null",
        )
        .order("fast_lane", { ascending: false })
        .order("priority", { ascending: false })
        .limit(1);
  const { data: sourceData } = await sourceQuery.maybeSingle();
  if (!sourceData) return response(200, { ok: true, skipped: true, reason: "NO_SOURCE_DUE" });
  const baseSource = sourceData as Source;
  const personalisedTerms = refreshSignal
    ? [
        refreshSignal.region,
        refreshSignal.province,
        refreshSignal.municipality,
        refreshSignal.ateco_prefix ? `ATECO ${refreshSignal.ateco_prefix}` : null,
        refreshSignal.company_size,
        ...(refreshSignal.interest_categories ?? []),
        refreshSignal.female_business ? "imprenditoria femminile" : null,
        refreshSignal.youth_business ? "imprenditoria giovanile" : null,
        refreshSignal.innovative_business ? "startup PMI innovativa" : null,
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const source: Source = {
    ...baseSource,
    search_query: `${baseSource.search_query} ${personalisedTerms}`.trim(),
  };
  const { data: run } = await sb
    .from("trovabandi_runs")
    .insert({
      action: "collect",
      source_id: source.id,
      trigger_source: normalizeText(body.trigger_source) || "replit",
    })
    .select("id")
    .single();
  const warnings: string[] = [];
  try {
    const [fc, pp] = await Promise.all([firecrawlSearch(source), perplexitySearch(source)]);
    if (!env("FIRECRAWL_API_KEY")) warnings.push("FIRECRAWL_API_KEY missing");
    if (!env("PERPLEXITY_API_KEY")) warnings.push("PERPLEXITY_API_KEY missing");
    const byUrl = new Map<string, SearchHit>();
    for (const hit of [...fc, ...pp]) {
      const previous = byUrl.get(hit.url);
      byUrl.set(
        hit.url,
        previous ? { ...previous, provider: `${previous.provider}+${hit.provider}` } : hit,
      );
    }
    const hits = [...byUrl.values()].slice(0, maxPages);
    let processed = 0;
    let verified = 0;
    let pagesScraped = 0;
    // Guasti operativi: degradano il run a PARTIAL e non sbloccano il gate.
    let operationalFailures = 0;
    // Diagnostica non sensibile: solo fase + codice, mai URL completi o contenuti.
    const diagnostics: Array<{ phase: string; code: string }> = [];
    for (const hit of hits) {
      const scraped = await loadPage(hit.url);
      if (!scraped) {
        diagnostics.push({ phase: "scrape", code: "NO_CONTENT" });
        warnings.push(`scrape_failed:${new URL(hit.url).hostname}`);
        operationalFailures++;
        continue;
      }
      // pages_scraped misura gli scrape riusciti, non i tentativi.
      pagesScraped++;
      diagnostics.push({ phase: "scrape", code: `OK_${scraped.provider.toUpperCase()}` });
      const extracted = await extractOpportunity(source, hit, scraped.markdown);
      if (!extracted.ok) {
        diagnostics.push({ phase: "extract", code: extracted.code });
        // NOT_OPPORTUNITY e gli altri esiti negativi validi non generano warning.
        if (isOperationalFailure(extracted.code)) {
          warnings.push(`extract_${extracted.code.toLowerCase()}`);
          operationalFailures++;
        }
        continue;
      }
      diagnostics.push({
        phase: "extract",
        code: extracted.mode === "json_fallback" ? "OK_FALLBACK" : "OK_SCHEMA",
      });
      const stored = await storeOpportunity(
        sb,
        source,
        hit,
        extracted.data,
        scraped.markdown,
        scraped.provider,
      );
      diagnostics.push({ phase: "store", code: stored.code });
      if (!stored.stored) {
        warnings.push(`store_${stored.code.toLowerCase()}`);
        operationalFailures++;
        continue;
      }
      processed++;
      if (stored.verified) verified++;
    }

    const diagnosticCounters = aggregateDiagnostics(diagnostics);
    const finished = new Date().toISOString();
    await Promise.all([
      sb
        .from("trovabandi_sources")
        .update({
          last_scanned_at: finished,
          next_scan_at: new Date(
            Date.now() + Math.max(15, Number(source.scan_interval_minutes || 360)) * 60_000,
          ).toISOString(),
          updated_at: finished,
        })
        .eq("id", source.id),
      run?.id
        ? sb
            .from("trovabandi_runs")
            .update({
              status: operationalFailures > 0 ? "PARTIAL" : "SUCCEEDED",
              discovered_count: byUrl.size,
              processed_count: processed,
              verified_count: verified,
              provider_usage: {
                firecrawl_search: fc.length,
                perplexity_search: pp.length,
                pages_attempted: hits.length,
                pages_scraped: pagesScraped,
                diagnostics: diagnosticCounters,
              },

              warnings: [...new Set(warnings)],
              finished_at: finished,
            })
            .eq("id", run.id)
        : Promise.resolve(),
      refreshSignal?.id
        ? sb
            .from("trovabandi_refresh_requests")
            .update({ processed_at: finished })
            .eq("id", refreshSignal.id)
        : Promise.resolve(),
    ]);
    return response(200, {
      ok: true,
      source: source.name,
      status: operationalFailures > 0 ? "PARTIAL" : "SUCCEEDED",
      discovered: byUrl.size,
      attempted: hits.length,
      scraped: pagesScraped,
      processed,
      verified,

      warnings: [...new Set(warnings)],
      diagnostics: diagnosticCounters,
    });

  } catch (error) {
    if (run?.id)
      await sb
        .from("trovabandi_runs")
        .update({
          status: "FAILED",
          error_code: error instanceof Error ? error.name : "UNKNOWN",
          warnings,
          finished_at: new Date().toISOString(),
        })
        .eq("id", run.id);
    return response(500, { ok: false, code: "COLLECT_FAILED" });
  }
});
