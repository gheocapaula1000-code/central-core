import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// P0 Civiko One / Padova — tipo_lead fail-closed su TUTTI i portali.
// Mirror TS della logica SQL (civiko_classify_tipo_lead / civiko_merge_tipo_lead)
// + assert statici sulla migrazione e sull'isolamento dalle altre PWA.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATION_PATH = resolve(
  process.cwd(),
  "docs/pending-migrations/20260806150000_civiko_padova_tipo_lead_fail_closed_all_portals.sql",
);
const DISPATCH_PATH = resolve(
  process.cwd(),
  "supabase/functions/civiko-orchestrator-dispatch/index.ts",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");
const dispatch = readFileSync(DISPATCH_PATH, "utf8");

const PRIVATE_AGENCY_MARKER = /^(privato|privati|proprietario|proprietaria|priv\.?)$/;

export function classifyTipoLead(
  srcTipoLead: string | null | undefined,
  nAgenzie: number | null | undefined,
  agency: string | null | undefined,
): "AGENZIA" | "PRIVATO" | null {
  const src = (srcTipoLead ?? "").trim().toUpperCase() || null;
  const ag = (agency ?? "").trim() || null;
  if (src === "AGENZIA") return "AGENZIA";
  if ((nAgenzie ?? 0) > 0) return "AGENZIA";
  if (ag && !PRIVATE_AGENCY_MARKER.test(ag.toLowerCase())) return "AGENZIA";
  if (src === "PRIVATO") return "PRIVATO";
  return null;
}

export function mergeTipoLead(
  existing: string | null,
  incoming: "AGENZIA" | "PRIVATO" | null,
): string | null {
  if (incoming === null) return existing;
  if (incoming === "AGENZIA") return "AGENZIA";
  if ((existing ?? "").toUpperCase() === "AGENZIA") return existing;
  if (existing === "privato_stanco") return existing;
  return "PRIVATO";
}

describe("Civiko Padova — classificazione tipo_lead fail-closed", () => {
  it("Casa/Immobiliare/Subito professionali NON diventano privati", () => {
    expect(classifyTipoLead("AGENZIA", null, "Tecnocasa Padova")).toBe("AGENZIA");
    expect(classifyTipoLead("standard", 2, null)).toBe("AGENZIA");
    expect(classifyTipoLead(null, null, "Gabetti Padova")).toBe("AGENZIA");
    expect(classifyTipoLead("contendibile", 1, "Remax")).toBe("AGENZIA");
  });

  it("un privato esplicito resta privato", () => {
    expect(classifyTipoLead("PRIVATO", 0, null)).toBe("PRIVATO");
    expect(classifyTipoLead("privato", null, "privato")).toBe("PRIVATO");
    expect(classifyTipoLead(" Privato ", 0, "Proprietario")).toBe("PRIVATO");
  });

  it("caso ambiguo resta non classificato (fail-closed, mai PRIVATO inventato)", () => {
    for (const bad of [null, undefined, "", "  ", "standard", "ribasso", "contendibile"]) {
      expect(classifyTipoLead(bad as string | null, null, null)).toBeNull();
      expect(classifyTipoLead(bad as string | null, 0, "   ")).toBeNull();
    }
  });

  it("il segnale professionale prevale sul PRIVATO dichiarato", () => {
    expect(classifyTipoLead("PRIVATO", 3, null)).toBe("AGENZIA");
    expect(classifyTipoLead("PRIVATO", null, "Immobiliare Euganea")).toBe("AGENZIA");
  });

  it("il merge non declassa mai una classificazione affidabile", () => {
    expect(mergeTipoLead("AGENZIA", "PRIVATO")).toBe("AGENZIA");
    expect(mergeTipoLead("privato_stanco", "PRIVATO")).toBe("privato_stanco");
    expect(mergeTipoLead("privato_stanco", "AGENZIA")).toBe("AGENZIA");
    expect(mergeTipoLead("PRIVATO", "AGENZIA")).toBe("AGENZIA");
    expect(mergeTipoLead("PRIVATO", null)).toBe("PRIVATO");
    expect(mergeTipoLead(null, null)).toBeNull();
    expect(mergeTipoLead(null, "PRIVATO")).toBe("PRIVATO");
  });
});

describe("Migrazione P0 — contenuto e ambito", () => {
  it("nessun default PRIVATO hardcodato in promozione", () => {
    expect(sql).not.toContain("'PRIVATO'::text");
  });

  it("entrambi i rami usano il classificatore fail-closed", () => {
    expect(
      sql.match(/public\.civiko_classify_tipo_lead\(tipo_lead, n_agenzie, agency\)/g)?.length,
    ).toBe(2);
  });

  it("il risanamento storico è limitato ai record Civiko attivi", () => {
    const heal = sql.slice(sql.indexOf("-- ── 4."));
    expect(heal).toContain("UPDATE public.padova_listings l");
    expect(heal).toContain("l.expired_at IS NULL");
    expect(heal).toContain("lower(l.fonte) IN ('casa', 'immobiliare', 'idealista', 'subito')");
    expect(heal).toContain("s.classified IS NOT NULL");
    // usa l'ultima riga sorgente dello stesso portale + URL
    expect(heal).toContain("DISTINCT ON (lower(portal), url)");
    expect(heal).toContain("ORDER BY lower(portal), url, updated_at DESC");
    // idempotente: nessuna scrittura se il valore non cambia
    expect(heal).toContain("IS DISTINCT FROM l.tipo_lead");
  });

  it("il risanamento non tocca URL, dati immobiliari o altre colonne", () => {
    const heal = sql.slice(sql.indexOf("-- ── 4."));
    const setClause = heal.slice(heal.indexOf("SET "), heal.indexOf("FROM src s"));
    expect(setClause).toContain("tipo_lead =");
    for (const forbidden of ["url =", "prezzo =", "mq =", "quartiere =", "raw_json =", "agency ="]) {
      expect(setClause).not.toContain(forbidden);
    }
  });

  it("non tocca TrovaBandi o altre PWA", () => {
    for (const foreign of [
      "trovabandi",
      "wyloni",
      "sottra",
      "keydraft",
      "luxu",
      "b2b_",
    ]) {
      expect(sql.toLowerCase()).not.toContain(foreign);
    }
  });

  it("non crea né attiva cron", () => {
    expect(sql.toLowerCase()).not.toContain("cron.schedule");
    expect(sql.toLowerCase()).not.toContain("cron.alter_job");
  });
});

describe("Copertura end-to-end dei tre flussi Civiko", () => {
  function stepsOf(pipeline: string): string[] {
    const marker = `${pipeline}: {`;
    const start = dispatch.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const seg = dispatch.slice(start, dispatch.indexOf("},", dispatch.indexOf("steps:", start)));
    const stepsPart = seg.slice(seg.indexOf("steps:"));
    return Array.from(stepsPart.matchAll(/"([a-z_0-9]+)"/g)).map((m) => m[1]);
  }

  const s0510 = stepsOf("pipeline_0510");
  const s0545 = stepsOf("pipeline_0545");
  const s0710 = stepsOf("pipeline_0710");
  const all = [...s0510, ...s0545, ...s0710];

  it("05:10 copre la raccolta portali", () => {
    for (const s of ["portal_casa", "apify_immobiliare", "apify_idealista", "apify_subito"]) {
      expect(s0510).toContain(s);
    }
  });

  it("05:45 copre importazione/promozione, classificazione e snapshot prezzi", () => {
    for (const s of ["collect_pending", "listings_promote", "private_leads_classify", "price_snapshot", "radar_full"]) {
      expect(s0545).toContain(s);
    }
    // la promozione precede classificazione e snapshot
    expect(s0545.indexOf("listings_promote")).toBeLessThan(s0545.indexOf("private_leads_classify"));
    expect(s0545.indexOf("private_leads_classify")).toBeLessThan(s0545.indexOf("price_snapshot"));
  });

  it("07:10 copre contendibili/evidence, certificazione fotografica ed extra segnali", () => {
    for (
      const s of [
        "contendibili_backfill",
        "contendibili_image_certify",
        "contendibili_recompute",
        "contendibili_evidence",
        "contendibili_extras",
        "offmarket_discover",
        "offmarket_scores",
        "early_warning",
        "signals_classify",
      ]
    ) {
      expect(s0710).toContain(s);
    }
    // la certificazione fotografica precede il recompute autoritativo
    expect(s0710.indexOf("contendibili_image_certify")).toBeLessThan(
      s0710.indexOf("contendibili_recompute"),
    );
  });

  it("la certificazione fotografica è invocabile e non gira in dry-run", () => {
    expect(dispatch).toContain('fn: "civiko-contendibili-image-certify"');
    expect(dispatch).toContain("body: { limit: 40, dry_run: false }");
  });

  it("nessuna fase dei flussi è eseguita in dry-run", () => {
    expect(dispatch).not.toContain("dry_run: true");
  });

  it("ogni step appartiene all'allowlist", () => {
    const allowed = dispatch.slice(dispatch.indexOf("const ALLOWED"), dispatch.indexOf("const PIPELINES"));
    for (const s of all) expect(allowed).toContain(`${s}: {`);
  });

  it("il dispatcher non crea né attiva cron DB", () => {
    expect(dispatch).toContain("const CRON_ENABLED = false");
    expect(dispatch.toLowerCase()).not.toContain("cron.schedule");
  });

  it("nessuna action TrovaBandi o di altre PWA nel dispatcher Civiko", () => {
    for (const foreign of ["trovabandi", "wyloni", "sottra", "keydraft", "luxu"]) {
      expect(dispatch.toLowerCase()).not.toContain(foreign);
    }
  });
});
