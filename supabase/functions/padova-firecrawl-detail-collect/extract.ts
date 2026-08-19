// Pure extractors for Padova Firecrawl detail pages. No fetch, no secrets.

export function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

export function num(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = String(s).replace(/\./g, "").replace(",", ".").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

export function intOnly(s: string | null | undefined): number | null {
  const n = num(s);
  return n == null ? null : Math.round(n);
}

export function looksLikeAgencyName(s: string | null | undefined): boolean {
  if (!s) return false;
  const v = s.trim();
  if (v.length < 3 || v.length > 120) return false;
  if (/[\[\]()]/.test(v)) return false;
  if (/https?:\/\//i.test(v)) return false;
  if (/\bwww\./i.test(v)) return false;
  if (/[<>]/.test(v)) return false;
  const blacklist = [
    "agenzie", "agenzia", "trova agenzia", "trova agenzie",
    "cerca agenzia", "scopri agenzia", "vedi agenzia",
    "annuncio privato", "privato", "venditore privato",
    "contatta", "richiedi info", "richiedi informazioni",
    "scopri di piu", "scopri di più", "leggi di piu", "leggi di più",
    "agente immobiliare", "immobiliare",
  ];
  const norm = v.toLowerCase().replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (blacklist.includes(norm)) return false;
  if (!/\p{L}/u.test(v)) return false;
  return true;
}

export function isValidItalianPhone(tel: string): boolean {
  if (!tel) return false;
  const digits = tel.replace(/^\+/, "").replace(/^39/, "");
  const PIVA_BLACKLIST = [
    "08435221000",
    "06647441",
  ];
  if (PIVA_BLACKLIST.includes(digits) || PIVA_BLACKLIST.includes(tel.replace(/[^\d]/g, ""))) return false;
  if (digits.length < 6 || digits.length > 11) return false;
  if (/^3\d{8,9}$/.test(digits)) return true;
  if (/^0\d{5,9}$/.test(digits)) return true;
  return false;
}

export function extractFromContent(markdown: string, html: string): Record<string, unknown> {
  const rawText = `${markdown}\n${html.replace(/<[^>]+>/g, " ")}`;
  const text = rawText.toLowerCase();
  const out: Record<string, unknown> = {};

  if (/la pagina che stai cercando non è presente|non è più disponibile/i.test(rawText)) {
    out._gone = true;
  }

  try {
    const ldBlocks = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
    const walk = (it: Record<string, unknown> | null | undefined) => {
      if (!it || typeof it !== "object") return;
      const fs = (it as { floorSize?: { value?: unknown } | unknown }).floorSize as { value?: unknown } | unknown;
      const fsv = (fs && typeof fs === "object" && "value" in (fs as Record<string, unknown>))
        ? (fs as { value?: unknown }).value
        : fs;
      if (fsv && !out.mq) out.mq = intOnly(String(fsv));
      const nr = (it as Record<string, unknown>).numberOfRooms ?? (it as Record<string, unknown>).numberOfRoomsTotal;
      if (nr && !out.locali) out.locali = intOnly(String(nr));
      const nb = (it as Record<string, unknown>).numberOfBathroomsTotal ?? (it as Record<string, unknown>).numberOfBathrooms;
      if (nb && !out.bagni) out.bagni = intOnly(String(nb));
      const ag = (it as { realEstateAgent?: { name?: string }; provider?: { name?: string }; seller?: { name?: string } });
      const agName = ag?.realEstateAgent?.name ?? ag?.provider?.name ?? ag?.seller?.name;
      if (agName && !out.agency) out.agency = clean(String(agName)).slice(0, 120);
      const agAny = ag as Record<string, { telephone?: unknown } | undefined>;
      const agPhone = agAny?.realEstateAgent?.telephone ?? agAny?.provider?.telephone ?? agAny?.seller?.telephone;
      if (agPhone && !out.agency_phone) {
        const tel = String(agPhone).replace(/[^\d+]/g, "");
        if (tel.length >= 6 && tel.length <= 20) out.agency_phone = tel;
      }
      const geo = (it as { geo?: { latitude?: unknown; longitude?: unknown }; address?: { geo?: { latitude?: unknown; longitude?: unknown } } });
      const lat = geo?.geo?.latitude ?? geo?.address?.geo?.latitude;
      const lng = geo?.geo?.longitude ?? geo?.address?.geo?.longitude;
      if (lat != null && lng != null && !out.lat) {
        const la = Number(lat), lo = Number(lng);
        if (Number.isFinite(la) && Number.isFinite(lo)) { out.lat = la; out.lng = lo; }
      }
      const graph = (it as { ["@graph"]?: unknown[] })["@graph"];
      if (Array.isArray(graph)) for (const g of graph) walk(g as Record<string, unknown>);
    };
    for (const block of ldBlocks) {
      const inner = block.replace(/^[\s\S]*?>/, "").replace(/<\/script>\s*$/i, "");
      try {
        const obj = JSON.parse(inner);
        const items = Array.isArray(obj) ? obj : [obj];
        for (const it of items) walk(it as Record<string, unknown>);
      } catch { /* skip block */ }
    }
  } catch { /* ignore */ }

  if (!out.mq) {
    const patterns = [
      /(\d{2,4})\s*(?:mq|m²|m2|metri quadr)/i,
      /\bda\s+(\d{2,4})\s*m[²2 ]/i,
      /(?:superficie|dimensione)[^0-9]{0,20}(\d{2,4})/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) { out.mq = intOnly(m[1]); if (out.mq) break; }
    }
  }

  if (!out.locali) {
    const lM = text.match(/(\d{1,2})\s*(?:loca(?:li|le)|stanze|vani|camere)\b/);
    if (lM) out.locali = intOnly(lM[1]);
  }

  if (!out.bagni) {
    const bM = text.match(/(\d{1,2})\s*bagn[io]\b/);
    if (bM) out.bagni = intOnly(bM[1]);
  }

  const piM = text.match(/piano[:\s]+([a-z0-9°\-\s]{1,30})/);
  if (piM) out.piano = clean(piM[1]).slice(0, 60);

  const tipoM = text.match(/\b(appartamento|attico|villa|villetta|bilocale|trilocale|quadrilocale|monolocale|loft|mansarda|rustico|casa indipendente|porzione di casa)\b/);
  if (tipoM) out.tipologia = tipoM[1];

  const rM = text.match(/riscaldamento[:\s]+([a-z0-9,\s\-]{3,60})/);
  if (rM) out.riscaldamento = clean(rM[1]).slice(0, 80);

  const sM = text.match(/\bstato[:\s]+([a-z\s]{3,40})/);
  if (sM) out.stato = clean(sM[1]).slice(0, 60);

  const aM = text.match(/\banno (?:di )?costruzione[:\s]+(\d{4})/);
  if (aM) out.anno_costruzione = intOnly(aM[1]);

  const cM = text.match(/\b(?:via|viale|piazza|corso|largo|vicolo|strada|borgo|riviera|lungargine|calle|contr[aà]|stradella)\s+[a-zà-ù'.\s]{3,40}[, ]+(\d{1,4}[a-z]?)\b/i);
  if (cM) out.civico = cM[1];

  if (!out.agency) {
    const candidates: string[] = [];
    const m1 = html.match(/class="[^"]*agen[a-z\-_]*name[^"]*"[^>]*>([^<]{3,120})</i);
    if (m1) candidates.push(m1[1]);
    const m2 = html.match(/data-agency[a-z\-]*=["']([^"']{3,120})["']/i);
    if (m2) candidates.push(m2[1]);
    const m3 = html.match(/itemtype="[^"]*RealEstateAgent[^"]*"[\s\S]{0,500}?itemprop="name"[^>]*>([^<]{3,120})</i);
    if (m3) candidates.push(m3[1]);
    const m4 = html.match(/<meta[^>]+name=["'](?:publisher|author)["'][^>]+content=["']([^"']{3,120})["']/i);
    if (m4) candidates.push(m4[1]);
    for (const cand of candidates) {
      const cleaned = clean(cand).slice(0, 120);
      if (looksLikeAgencyName(cleaned)) { out.agency = cleaned; break; }
    }
  }

  if (!out.agency) {
    const mIm = markdown.match(/([^\[\]\n]{3,120})\]\(https?:\/\/(?:www\.)?immobiliare\.it\/agenzie-immobiliari\/\d+\/[^)]+\)/i);
    if (mIm) {
      const cand = clean(
        mIm[1]
          .replace(/\\+/g, " ")
          .replace(/^[\s\W]+|[\s\W]+$/g, ""),
      ).slice(0, 120);
      if (looksLikeAgencyName(cand)) out.agency = cand;
    }
  }

  if (out.agency && !looksLikeAgencyName(String(out.agency))) {
    out.agency = null;
  }

  if (!out.agency_phone) {
    const telLink = html.match(/href="tel:([^"]{6,20})"/i);
    if (telLink) {
      const tel = telLink[1].replace(/[^\d+]/g, "");
      if (isValidItalianPhone(tel)) out.agency_phone = tel;
    }

    if (!out.agency_phone) {
      const telM = html.match(/(?:\+?39[\s.\-]+)?(?:0\d{1,3}[\s.\-]+\d{5,8}|3\d{2}[\s.\-]+\d{6,7})/);
      if (telM) {
        const tel = telM[0].replace(/[^\d+]/g, "");
        if (isValidItalianPhone(tel)) out.agency_phone = tel;
      }
    }
  }

  if (!out.lat) {
    const blob = html + "\n" + markdown;
    const tries: Array<RegExpMatchArray | null> = [
      blob.match(/"latitude"\s*:\s*"?(-?\d+\.\d{3,})"?[\s\S]{0,120}?"longitude"\s*:\s*"?(-?\d+\.\d{3,})"?/i),
      blob.match(/"lat"\s*:\s*"?(-?\d+\.\d{3,})"?[\s\S]{0,120}?"l(?:o?n|ng)g?(?:itude)?"\s*:\s*"?(-?\d+\.\d{3,})"?/i),
      blob.match(/lat[=:]\s*(-?\d+\.\d{3,})[\s\S]{0,40}?l(?:o?n|ng)g?[=:]\s*(-?\d+\.\d{3,})/i),
      blob.match(/data-lat(?:itude)?\s*=\s*"(-?\d+\.\d{3,})"[\s\S]{0,200}?data-l(?:o?n|ng)g?(?:itude)?\s*=\s*"(-?\d+\.\d{3,})"/i),
      blob.match(/@(-?\d+\.\d{4,}),(-?\d+\.\d{4,})/),
    ];
    for (const m of tries) {
      if (m) {
        const la = Number(m[1]), lo = Number(m[2]);
        if (Number.isFinite(la) && Number.isFinite(lo) && la > 35 && la < 48 && lo > 6 && lo < 19) {
          out.lat = la; out.lng = lo; break;
        }
      }
    }
  }

  return out;
}
