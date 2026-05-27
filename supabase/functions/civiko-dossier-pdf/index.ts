// civiko-dossier-pdf — Edge Function
// POST /functions/v1/civiko-dossier-pdf
// Genera PDF stampabile dal dossier Padova.
// Usa pdf-lib@1.17.1 via esm.sh. Word-wrap manuale, nuova pagina auto.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";
import { makeDebugId, CORE_VERSION } from "../_shared/http.ts";
import { sanitizeOutgoing } from "../_shared/civiko.ts";

const FUNCTION_NAME = "civiko-dossier-pdf";

function wrapText(text: string, maxChars = 80): string[] {
  if (!text) return [];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + (current ? " " : "") + word).length > maxChars) {
      if (current) lines.push(current);
      if (word.length > maxChars) {
        let w = word;
        while (w.length > maxChars) { lines.push(w.slice(0, maxChars)); w = w.slice(maxChars); }
        current = w;
      } else {
        current = word;
      }
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  const debugId = makeDebugId();
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Usa POST" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  let body: { dossier?: Record<string, unknown> } = {};
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Body JSON non valido" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const dossier = body.dossier;
  if (!dossier) {
    return new Response(JSON.stringify({ error: "Campo 'dossier' obbligatorio" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const d = sanitizeOutgoing(dossier) as Record<string, unknown>;
  const immobile = (d.immobile ?? {}) as Record<string, unknown>;
  const sections = ((d.presentazioneProprietario as Record<string, unknown>)?.sections ?? []) as Array<Record<string, unknown>>;
  const sources = (d.sources ?? []) as Array<{ name: string; url: string }>;
  const warnings = (d.warnings ?? []) as string[];

  const address = String(immobile.address ?? "Indirizzo non specificato");
  const slug = address.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

  try {
    const pdfDoc = await PDFDocument.create();
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const PAGE_W = 595;
    const PAGE_H = 842;
    const MARGIN = 50;
    const MAX_W = PAGE_W - MARGIN * 2;
    const LINE_H = 14;
    const FONT_SIZE = 10;
    const TITLE_SIZE = 16;
    const SECTION_SIZE = 12;

    let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;

    function ensureLine(linesNeeded = 1) {
      if (y - LINE_H * linesNeeded < MARGIN + 20) {
        page = pdfDoc.addPage([PAGE_W, PAGE_H]);
        y = PAGE_H - MARGIN;
      }
    }

    function drawText(text: string, opts: { size?: number; bold?: boolean; color?: [number, number, number]; indent?: number } = {}) {
      const { size = FONT_SIZE, bold = false, color = [0.1, 0.1, 0.1], indent = 0 } = opts;
      const lines = wrapText(text, Math.floor((MAX_W - indent) / (size * 0.52)));
      for (const line of lines) {
        ensureLine();
        page.drawText(line, {
          x: MARGIN + indent,
          y,
          size,
          font: bold ? fontBold : fontRegular,
          color: rgb(color[0], color[1], color[2]),
        });
        y -= LINE_H;
      }
    }

    function drawSpacer(lines = 1) { y -= LINE_H * lines; }

    drawText("Dossier Proprietario - Padova", { size: TITLE_SIZE, bold: true, color: [0.1, 0.3, 0.6] });
    drawText("Metodo Civiko One", { size: FONT_SIZE, color: [0.4, 0.4, 0.4] });
    drawText(new Date().toLocaleDateString("it-IT", { year: "numeric", month: "long", day: "numeric" }), { size: FONT_SIZE, color: [0.5, 0.5, 0.5] });
    drawSpacer();

    drawText("Immobile", { size: SECTION_SIZE, bold: true });
    drawText(`Indirizzo: ${address}`);
    if (immobile.propertyType) drawText(`Tipologia: ${immobile.propertyType}`);
    if (immobile.sizeSqm) drawText(`Superficie: ${immobile.sizeSqm} mq`);
    if (immobile.rooms) drawText(`Locali: ${immobile.rooms}`);
    if (immobile.askingPrice) drawText(`Prezzo richiesto: EUR ${Number(immobile.askingPrice).toLocaleString("it-IT")}`);
    if (immobile.ownerGoal) drawText(`Obiettivo proprietario: ${immobile.ownerGoal}`);
    drawSpacer();

    const BADGE_LABELS: Record<string, string> = {
      pronta: "[Pronta]",
      da_collegare: "[Da collegare]",
      da_validare: "[Da validare]",
      da_consultare: "[Da consultare]",
    };

    for (const section of sections) {
      const title = String(section.title ?? "");
      const status = String(section.status ?? "da_collegare");
      const bullets = (section.bullets ?? []) as string[];
      const badge = BADGE_LABELS[status] ?? status;

      drawText(`${title}  ${badge}`, { size: SECTION_SIZE, bold: true, color: status === "pronta" ? [0.1, 0.5, 0.2] : [0.4, 0.4, 0.4] });
      for (const bullet of bullets.filter(Boolean)) {
        drawText(`- ${bullet}`, { indent: 12 });
      }
      if (bullets.length === 0 && status === "da_collegare") {
        drawText("- Dati in attesa di integrazione.", { indent: 12, color: [0.6, 0.6, 0.6] });
      }
      drawSpacer(0.5);
    }

    if (warnings.length > 0) {
      drawSpacer();
      drawText("Note", { size: SECTION_SIZE, bold: true, color: [0.6, 0.4, 0.0] });
      for (const w of warnings) drawText(`- ${w}`, { indent: 8, color: [0.5, 0.35, 0.0] });
    }

    drawSpacer();
    drawText("Fonti ufficiali", { size: SECTION_SIZE, bold: true });
    for (const src of sources) {
      drawText(`- ${src.name}: ${src.url}`, { indent: 8, color: [0.2, 0.2, 0.6] });
    }

    drawSpacer(2);
    drawText(`Generato con Metodo Civiko One - ${CORE_VERSION} - I dati provengono da fonti ufficiali. Non costituiscono perizia ne valutazione.`, { size: 8, color: [0.6, 0.6, 0.6] });

    const pdfBytes = await pdfDoc.save();

    return new Response(pdfBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="dossier-padova-${slug}.pdf"`,
        "X-Function": FUNCTION_NAME,
        "X-Debug-Id": debugId,
      },
    });
  } catch (e) {
    console.error("[civiko-dossier-pdf] errore generazione PDF:", e instanceof Error ? e.message : e);
    return new Response(JSON.stringify({ error: "Errore nella generazione del PDF. Riprova tra qualche istante." }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
