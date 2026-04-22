// ═══════════════════════════════════════════════════════════════
// Property Outputs — Language primitives & overclaim guards
//
// Single source of truth for precision-aware phrasing.
// Every commercial sentence about location, valuation, territory or
// signals MUST go through one of these helpers so we cannot accidentally
// say "al civico" when the source is comune-level, or "rivalutazione
// sicura" when we only have an OMI €/m² range.
// ═══════════════════════════════════════════════════════════════

import type {
  Audience,
  BlockProvenance,
  Confidence,
  IdentityIn,
  PrecisionLevel,
  SignalItemIn,
  TerritoryIndicatorIn,
  TerritoryIn,
  ValuationIn,
} from "./types.ts";

// ── Banned phrases (never emitted, regardless of audience) ───
//
// These are the "fake premium" phrases from the brief. They are blocked
// at the output layer, not at the provider layer, because providers
// already only return real signals — we just refuse to ever wrap them
// in unsupportable absolute commercial language.
const BANNED_CLIENT_PHRASES: ReadonlyArray<RegExp> = [
  /zona\s+sicur(?:issima|a\s+al\s+100%)/i,
  /vicinato\s+eccellente/i,
  /criminalit(?:à|a)\s+(?:assente|zero)/i,
  /sicura\s+rivalutazione/i,
  /rivalutazione\s+(?:certa|garantita)/i,
  /rendimento\s+garantito/i,
  /quartiere\s+top/i,
  /zero\s+rumore/i,
];

export function stripBannedClientPhrases(text: string): { text: string; suppressed: string[] } {
  const suppressed: string[] = [];
  let out = text;
  for (const rx of BANNED_CLIENT_PHRASES) {
    if (rx.test(out)) {
      suppressed.push(rx.source);
      out = out.replace(rx, "").replace(/\s{2,}/g, " ").trim();
    }
  }
  return { text: out, suppressed };
}

// ── Confidence / precision adverbs ───────────────────────────

export function confidenceAdverb(c: Confidence): string {
  switch (c) {
    case "alta":
      return "con buona affidabilità";
    case "media":
      return "indicativamente";
    case "bassa":
      return "in via preliminare";
  }
}

export function precisionQualifier(p: PrecisionLevel): string {
  switch (p) {
    case "building":
      return "all'edificio";
    case "civic":
      return "al civico";
    case "street":
      return "sulla via";
    case "microzone":
      return "nella micro-zona OMI";
    case "neighborhood":
      return "nel quartiere";
    case "comune":
      return "nel comune";
    case "provincia":
      return "nella provincia";
    case "regione":
      return "nella regione";
  }
}

/**
 * Decide if a piece of data is precise enough to be quoted as if it
 * referred directly to the civic. Rule: only `building` and `civic`
 * count as "address-level". Everything coarser MUST be qualified.
 */
export function isAddressLevel(p: PrecisionLevel): boolean {
  return p === "building" || p === "civic";
}

// ── Provenance footnote (agency only) ────────────────────────

export function provenanceCaveat(label: string, prov: BlockProvenance): string {
  const radius = prov.radiusMeters ? `, raggio ${prov.radiusMeters}m` : "";
  return `${label}: fonte ${prov.source}, confidenza ${prov.confidence}, scala ${prov.precisionLevel}/${prov.spatialScope}${radius}, aggiornato ${prov.updatedAt}`;
}

// ── Identity / address phrasing ──────────────────────────────

export function formatAddress(identity: IdentityIn): string {
  const civic = identity.indirizzo
    ? identity.civico
      ? `${identity.indirizzo}, ${identity.civico}`
      : identity.indirizzo
    : null;
  const tail = `${identity.cap ? identity.cap + " " : ""}${identity.comune} (${identity.provincia})`;
  return civic ? `${civic} — ${tail}` : tail;
}

/**
 * Locator phrase used in commercial copy. Honest about precision.
 * Examples:
 *   building/civic → "in Via X 12, Padova"
 *   street         → "lungo Via X, Padova"
 *   microzone      → "nella micro-zona OMI di Padova"
 *   comune         → "a Padova"
 */
export function locatorPhrase(identity: IdentityIn): string {
  const p = identity.provenance.precisionLevel;
  if (isAddressLevel(p) && identity.indirizzo) {
    return `in ${identity.indirizzo}${identity.civico ? " " + identity.civico : ""}, ${identity.comune}`;
  }
  if (p === "street" && identity.indirizzo) {
    return `lungo ${identity.indirizzo}, ${identity.comune}`;
  }
  if (p === "microzone" && identity.microZona) {
    return `nella micro-zona OMI ${identity.microZona} di ${identity.comune}`;
  }
  if (p === "neighborhood" && identity.microZona) {
    return `nel quartiere ${identity.microZona} di ${identity.comune}`;
  }
  return `a ${identity.comune}`;
}

// ── Valuation phrasing ───────────────────────────────────────

export function formatEuro(n: number): string {
  return new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 }).format(Math.round(n));
}

/**
 * Commercial valuation sentence. RESPECTS sqm vs total semantics.
 * If only €/m² is available, NEVER produce a guaranteed total.
 */
export function valuationSentence(v: ValuationIn, audience: Audience): string | null {
  const hasMq = v.prezzoMqStimato != null || (v.prezzoMqMinimo != null && v.prezzoMqMassimo != null);
  if (!hasMq) return null;

  const min = v.prezzoMqMinimo;
  const max = v.prezzoMqMassimo;
  const point = v.prezzoMqStimato;

  let mqPart: string;
  if (min != null && max != null && min !== max) {
    mqPart = `tra €${formatEuro(min)} e €${formatEuro(max)} al m²`;
  } else if (point != null) {
    mqPart = `intorno a €${formatEuro(point)} al m²`;
  } else if (point != null) {
    mqPart = `intorno a €${formatEuro(point)} al m²`;
  } else {
    return null;
  }

  const adv = confidenceAdverb(v.provenance.confidence);
  const scope = v.provenance.precisionLevel === "microzone"
    ? "per la micro-zona OMI di riferimento"
    : v.provenance.precisionLevel === "comune"
    ? "per il comune"
    : "per l'area";

  if (audience === "client") {
    return `Valori di mercato ${scope}: ${mqPart} (${adv}).`;
  }
  return `Valore €/m² ${scope}: ${mqPart}. ${adv}. Nessun valore totale dichiarato (richiede superficie verificata).`;
}

// ── Territory indicator phrasing ─────────────────────────────

const KIND_LABEL: Record<string, string> = {
  environmental_risk_inverse: "Profilo di rischio ambientale (sismico/idrogeologico)",
  demographic_age_profile: "Profilo demografico",
  residential_density: "Vocazione residenziale",
  service_proximity: "Prossimità ai servizi",
  green_proximity: "Prossimità ad aree verdi",
  mobility_access: "Accessibilità",
  traffic_pressure: "Pressione del traffico",
  noise_proxy: "Indicatore proxy di rumorosità",
};

export function indicatorLabel(kind: string): string {
  return KIND_LABEL[kind] ?? "Indicatore";
}

export function indicatorSentence(ind: TerritoryIndicatorIn, audience: Audience): string {
  const label = indicatorLabel(ind.kind);
  const scope = precisionQualifier(ind.provenance.precisionLevel);
  if (audience === "client") {
    // No raw "kind", no provenance, no "proxy" jargon at full strength.
    const friendly = ind.kind === "noise_proxy"
      ? "Contesto acustico (stima indiretta)"
      : ind.kind === "environmental_risk_inverse"
      ? "Profilo ambientale"
      : label;
    return `${friendly}: ${ind.value} (${scope}).`;
  }
  // Agency: keep "proxy" + scope explicit.
  const tag = ind.kind === "noise_proxy" ? " [proxy]" : "";
  return `${label}${tag} — ${ind.value} (${scope}, ${ind.provenance.confidence}).`;
}

// ── Signals phrasing ─────────────────────────────────────────

export function signalSentence(s: SignalItemIn, audience: Audience): string {
  const scope = precisionQualifier(s.provenance.precisionLevel);
  if (audience === "client") {
    return `${s.titolo} — ${s.descrizione} (${scope}).`;
  }
  return `${s.titolo} [${s.tipo}, ${s.orizzonte}] — ${s.descrizione}. Impatto stimato: ${s.impatto}. Scala: ${scope}, confidenza ${s.provenance.confidence}.`;
}

// ── Territory summary ────────────────────────────────────────

export function territorySummary(t: TerritoryIn, audience: Audience): string | null {
  if (!t.sommario) return null;
  const scope = precisionQualifier(t.provenance.precisionLevel);
  if (audience === "client") {
    return `${t.sommario} (${scope}).`;
  }
  return `${t.sommario} — scala ${scope}, confidenza ${t.provenance.confidence}, fonte ${t.provenance.source}.`;
}

// ── Final pass: refuse banned client phrases ─────────────────

export function safeClientText(input: string): { text: string; suppressed: string[] } {
  const trimmed = input.replace(/\s+/g, " ").trim();
  return stripBannedClientPhrases(trimmed);
}
