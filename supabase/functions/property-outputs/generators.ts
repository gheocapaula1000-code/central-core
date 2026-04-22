// ═══════════════════════════════════════════════════════════════
// Property Outputs — Generators for the 5 output families
//
// Each generator consumes a PropertyDetailIn + audience and returns an
// OutputDocument. All copy goes through language.ts so precision /
// confidence / spatial-scope rules are applied uniformly and
// overclaiming is impossible by construction.
// ═══════════════════════════════════════════════════════════════

import {
  confidenceAdverb,
  formatAddress,
  formatEuro,
  indicatorSentence,
  locatorPhrase,
  precisionQualifier,
  provenanceCaveat,
  safeClientText,
  signalSentence,
  territorySummary,
  valuationSentence,
} from "./language.ts";
import type {
  Audience,
  OutputDocument,
  OutputFamily,
  OutputSection,
  PropertyDetailIn,
  SignalItemIn,
  TerritoryIndicatorIn,
  TerritoryIn,
  ValuationIn,
} from "./types.ts";

interface BuildCtx {
  audience: Audience;
  detail: PropertyDetailIn;
  appliedRules: string[];
  suppressed: string[];
}

function pushClient(ctx: BuildCtx, raw: string): string {
  const { text, suppressed } = safeClientText(raw);
  if (suppressed.length) ctx.suppressed.push(...suppressed);
  return text;
}

function listIndicators(t: TerritoryIn | null): TerritoryIndicatorIn[] {
  if (!t || !t.indicatori) return [];
  return Object.values(t.indicatori).filter((x): x is TerritoryIndicatorIn => x != null);
}

// ─────────────────────────────────────────────────────────────
// Family 1 — report_agenzia (internal, full truth)
// ─────────────────────────────────────────────────────────────
function buildReportAgenzia(ctx: BuildCtx): OutputSection[] {
  const { detail } = ctx;
  const sections: OutputSection[] = [];

  if (detail.identity) {
    const i = detail.identity;
    const lines = [
      `Indirizzo: ${formatAddress(i)}`,
      `Coordinate: ${i.coordinate.lat.toFixed(6)}, ${i.coordinate.lng.toFixed(6)}`,
      `Micro-zona OMI: ${i.microZona ?? "—"} (${i.zonaOmi ?? "—"})`,
      `Tipologia: ${i.tipologia ?? "—"} · Superficie: ${i.superficieMq ?? "—"} m² · Locali: ${i.locali ?? "—"}`,
      `Piano: ${i.piano ?? "—"} · Anno: ${i.annoCostruzione ?? "—"} · Classe energetica: ${i.classeEnergetica ?? "—"}`,
      `Stato: ${i.stato ?? "—"}`,
    ];
    sections.push({
      heading: "Identità immobile",
      body: lines.join("\n"),
      clientFacing: false,
      caveats: [provenanceCaveat("identity", i.provenance)],
    });
    ctx.appliedRules.push("agency.identity.full");
  } else {
    sections.push({
      heading: "Identità immobile",
      body: "Dato non disponibile.",
      clientFacing: false,
      caveats: ["identity: unavailable"],
    });
    ctx.appliedRules.push("agency.identity.unavailable");
  }

  if (detail.valuation) {
    const v = detail.valuation;
    const lines: string[] = [];
    if (v.prezzoMqMinimo != null && v.prezzoMqMassimo != null) {
      lines.push(`€/m² range: €${formatEuro(v.prezzoMqMinimo)} – €${formatEuro(v.prezzoMqMassimo)}`);
    }
    if (v.prezzoMqStimato != null) lines.push(`€/m² puntuale: €${formatEuro(v.prezzoMqStimato)}`);
    lines.push(`Valori totali: ${v.prezzoTotaleStimato == null ? "non emessi (richiede superficie verificata)" : "—"}`);
    if (v.drivers) lines.push(`Driver: ${v.drivers}`);
    sections.push({
      heading: "Valutazione (€/m²)",
      body: lines.join("\n"),
      clientFacing: false,
      caveats: [provenanceCaveat("valuation", v.provenance)],
    });
    ctx.appliedRules.push("agency.valuation.sqm_only");
  }

  if (detail.territory) {
    const t = detail.territory;
    const inds = listIndicators(t);
    const lines: string[] = [];
    if (t.sommario) lines.push(t.sommario);
    if (t.puntiForti?.length) lines.push("Punti forti: " + t.puntiForti.join("; "));
    if (t.criticita?.length) lines.push("Criticità: " + t.criticita.join("; "));
    for (const ind of inds) lines.push("• " + indicatorSentence(ind, "agency"));
    if (t.scenarioFuturo) lines.push("Scenario: " + t.scenarioFuturo);
    sections.push({
      heading: "Territorio (scala e indicatori)",
      body: lines.join("\n") || "Dato non disponibile.",
      clientFacing: false,
      caveats: [
        provenanceCaveat("territory", t.provenance),
        ...inds.map((i) => provenanceCaveat(`indicator:${i.kind}`, i.provenance)),
      ],
    });
    ctx.appliedRules.push("agency.territory.full");
  }

  if (detail.signals && detail.signals.length > 0) {
    sections.push({
      heading: "Segnali area / sviluppo",
      body: detail.signals.map((s) => "• " + signalSentence(s, "agency")).join("\n"),
      clientFacing: false,
      caveats: detail.signals.map((s) => provenanceCaveat(`signal:${s.id}`, s.provenance)),
    });
    ctx.appliedRules.push("agency.signals.full");
  }

  return sections;
}

// ─────────────────────────────────────────────────────────────
// Family 2 — annuncio_lungo (client-facing, polished long copy)
// ─────────────────────────────────────────────────────────────
function buildAnnuncioLungo(ctx: BuildCtx): OutputSection[] {
  const { detail } = ctx;
  const sections: OutputSection[] = [];
  const i = detail.identity;
  if (!i) return sections;

  const opener = pushClient(
    ctx,
    `${i.tipologia ?? "Immobile"} ${locatorPhrase(i)}${
      i.superficieMq ? `, di circa ${i.superficieMq} m²` : ""
    }${i.locali ? `, ${i.locali} locali` : ""}.`,
  );
  sections.push({ heading: "Presentazione", body: opener, clientFacing: true });
  ctx.appliedRules.push("client.annuncio.opener.precision_aware");

  // Valutazione (sqm-only, no fake total)
  if (detail.valuation) {
    const sentence = valuationSentence(detail.valuation, "client");
    if (sentence) {
      sections.push({ heading: "Riferimenti di mercato", body: pushClient(ctx, sentence), clientFacing: true });
      ctx.appliedRules.push("client.valuation.sqm_only");
    }
  }

  // Territorio: sommario + indicatori (commerciali)
  if (detail.territory) {
    const t = detail.territory;
    const lines: string[] = [];
    const sum = territorySummary(t, "client");
    if (sum) lines.push(sum);
    if (t.puntiForti?.length) lines.push("Tra i punti di forza dell'area: " + t.puntiForti.slice(0, 3).join(", ") + ".");
    const inds = listIndicators(t).slice(0, 3);
    for (const ind of inds) lines.push(indicatorSentence(ind, "client"));
    if (lines.length) {
      sections.push({ heading: "Contesto", body: pushClient(ctx, lines.join(" ")), clientFacing: true });
      ctx.appliedRules.push("client.territory.scope_aware");
    }
  }

  // Segnali: solo se reali
  if (detail.signals && detail.signals.length > 0) {
    const lines = detail.signals.slice(0, 3).map((s) => signalSentence(s, "client"));
    sections.push({ heading: "Sviluppi d'area", body: pushClient(ctx, lines.join(" ")), clientFacing: true });
    ctx.appliedRules.push("client.signals.real_only");
  }

  return sections;
}

// ─────────────────────────────────────────────────────────────
// Family 3 — annuncio_portali (short, portal-friendly)
// ─────────────────────────────────────────────────────────────
function buildAnnuncioPortali(ctx: BuildCtx): OutputSection[] {
  const { detail } = ctx;
  const i = detail.identity;
  if (!i) return [];
  const v = detail.valuation;

  const head = `${i.tipologia ?? "Immobile"} ${locatorPhrase(i)}${
    i.superficieMq ? `, ${i.superficieMq} m²` : ""
  }${i.locali ? `, ${i.locali} locali` : ""}${i.classeEnergetica ? `, classe ${i.classeEnergetica}` : ""}.`;

  const valBit = v ? valuationSentence(v, "client") : null;

  const body = pushClient(ctx, [head, valBit].filter(Boolean).join(" "));
  ctx.appliedRules.push("client.portali.compact.precision_aware");

  return [{ heading: "Annuncio sintetico", body, clientFacing: true }];
}

// ─────────────────────────────────────────────────────────────
// Family 4 — fascicolo_cliente (premium, structured, client-facing)
// ─────────────────────────────────────────────────────────────
function buildFascicoloCliente(ctx: BuildCtx): OutputSection[] {
  const { detail } = ctx;
  const sections: OutputSection[] = [];
  const i = detail.identity;
  if (!i) return sections;

  sections.push({
    heading: "L'immobile",
    body: pushClient(
      ctx,
      `${i.tipologia ?? "Immobile"} ${locatorPhrase(i)}${
        i.superficieMq ? `, superficie ${i.superficieMq} m²` : ""
      }${i.locali ? `, ${i.locali} locali` : ""}${i.piano ? `, piano ${i.piano}` : ""}${
        i.classeEnergetica ? `, classe energetica ${i.classeEnergetica}` : ""
      }.`,
    ),
    clientFacing: true,
  });
  ctx.appliedRules.push("client.fascicolo.identity.precision_aware");

  if (detail.valuation) {
    const s = valuationSentence(detail.valuation, "client");
    if (s) {
      sections.push({
        heading: "Inquadramento di valore",
        body: pushClient(ctx, s + " I valori esprimono un riferimento di mercato e non costituiscono perizia."),
        clientFacing: true,
      });
      ctx.appliedRules.push("client.fascicolo.valuation.sqm_only");
    }
  }

  if (detail.territory) {
    const t = detail.territory;
    const parts: string[] = [];
    const sum = territorySummary(t, "client");
    if (sum) parts.push(sum);
    const inds = listIndicators(t);
    for (const ind of inds) parts.push(indicatorSentence(ind, "client"));
    if (parts.length) {
      sections.push({
        heading: "Il contesto",
        body: pushClient(ctx, parts.join(" ")),
        clientFacing: true,
      });
      ctx.appliedRules.push("client.fascicolo.territory.scope_aware");
    }
  }

  if (detail.signals && detail.signals.length > 0) {
    sections.push({
      heading: "Prospettive d'area",
      body: pushClient(ctx, detail.signals.map((s) => signalSentence(s, "client")).join(" ")),
      clientFacing: true,
    });
    ctx.appliedRules.push("client.fascicolo.signals.real_only");
  }

  return sections;
}

// ─────────────────────────────────────────────────────────────
// Family 5 — locandina (one-pager, very short)
// ─────────────────────────────────────────────────────────────
function buildLocandina(ctx: BuildCtx): OutputSection[] {
  const { detail } = ctx;
  const i = detail.identity;
  if (!i) return [];
  const v = detail.valuation;

  const head = `${(i.tipologia ?? "Immobile").toUpperCase()} ${locatorPhrase(i)}`;
  const specs = [
    i.superficieMq ? `${i.superficieMq} m²` : null,
    i.locali ? `${i.locali} locali` : null,
    i.classeEnergetica ? `classe ${i.classeEnergetica}` : null,
  ].filter(Boolean).join(" · ");

  const valBit = v ? valuationSentence(v, "client") : null;

  ctx.appliedRules.push("client.locandina.compact.precision_aware");
  return [
    { heading: "Titolo", body: pushClient(ctx, head), clientFacing: true },
    ...(specs ? [{ heading: "Caratteristiche", body: pushClient(ctx, specs), clientFacing: true }] : []),
    ...(valBit ? [{ heading: "Mercato", body: pushClient(ctx, valBit), clientFacing: true }] : []),
  ];
}

// ─────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────
export function generateDocument(
  family: OutputFamily,
  audience: Audience,
  detail: PropertyDetailIn,
): OutputDocument {
  const ctx: BuildCtx = { audience, detail, appliedRules: [], suppressed: [] };

  // Hard rule: client-facing families ignore "agency" audience requests
  // for caveat exposure, but the audience flag still controls phrasing.
  // Agency-only family `report_agenzia` forces audience=agency phrasing.
  const effectiveAudience: Audience = family === "report_agenzia" ? "agency" : audience;
  ctx.audience = effectiveAudience;

  let sections: OutputSection[] = [];
  switch (family) {
    case "report_agenzia":
      sections = buildReportAgenzia(ctx);
      break;
    case "annuncio_lungo":
      sections = buildAnnuncioLungo(ctx);
      break;
    case "annuncio_portali":
      sections = buildAnnuncioPortali(ctx);
      break;
    case "fascicolo_cliente":
      sections = buildFascicoloCliente(ctx);
      break;
    case "locandina":
      sections = buildLocandina(ctx);
      break;
  }

  // Strip caveats from any client-facing section (defense in depth).
  if (effectiveAudience === "client") {
    sections = sections.map((s) => ({ ...s, caveats: undefined, clientFacing: true }));
  }

  const i = detail.identity;
  const title = i
    ? `${i.tipologia ?? "Immobile"} — ${i.comune}`
    : `Immobile ${detail.id}`;
  const subtitle = i
    ? `${precisionQualifier(i.provenance.precisionLevel)} · ${confidenceAdverb(i.provenance.confidence)}`
    : null;

  return {
    family,
    audience: effectiveAudience,
    propertyId: detail.id,
    title,
    subtitle,
    sections,
    appliedRules: ctx.appliedRules,
    suppressedClaims: ctx.suppressed,
    availability: {
      identity: !!detail.identity,
      territory: !!detail.territory,
      valuation: !!detail.valuation,
      signals: !!(detail.signals && detail.signals.length > 0),
    },
    generatedAt: new Date().toISOString(),
  };
}
