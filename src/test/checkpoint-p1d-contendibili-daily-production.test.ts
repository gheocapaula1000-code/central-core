import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseContendibileDetail,
  extractUnitReference,
  DETAIL_EVIDENCE_VERSION,
} from "../../supabase/functions/_shared/queue-processors/civikoContendibileDetail";

const root = process.cwd();
const enqueue = readFileSync(
  join(root, "supabase/functions/civiko-contendibili-evidence-refresh/index.ts"),
  "utf8",
);
const processor = readFileSync(
  join(root, "supabase/functions/scraping-result-processor/index.ts"),
  "utf8",
);
const migration = readFileSync(
  join(root, "supabase/migrations/20260802040000_civiko_contendibili_daily_production.sql"),
  "utf8",
);

describe("P1-D — parser scheda dettaglio", () => {
  it("estrae via, civico e piano solo dal testo della scheda reale", () => {
    const out = parseContendibileDetail({
      data: {
        metadata: { title: "Appartamento in vendita a Padova" },
        markdown: `
          Appartamento in Via Tullio Lombardo 18, Padova.
          L'unità si trova al secondo piano con ascensore.
          Ampio soggiorno luminoso, cucina separata, due camere, bagno finestrato,
          terrazzo abitabile, riscaldamento autonomo e garage. La soluzione è
          descritta con dettagli completi per consentire una corretta valutazione.
          Rif. immobile AB-247.
        `,
      },
    }, {
      listing_id: 42,
      url: "https://www.immobiliare.it/annunci/42/",
      commercial_zone_slug: "nord-arcella",
    });
    expect(out.version).toBe(DETAIL_EVIDENCE_VERSION);
    expect(out.via_norm).toContain("tullio-lombardo");
    expect(out.civico_norm).toBe("18");
    expect(out.piano_key).toBe("P2");
    expect(out.unit_ref).toBe("ab-247");
  });

  it("non trasforma un quartiere o i mq in civico", () => {
    const out = parseContendibileDetail({
      data: {
        markdown: "Arcella, Padova. Appartamento di 120 mq con quattro locali e due bagni. ".repeat(5),
      },
    }, {
      listing_id: 43,
      url: "https://www.casa.it/immobili/43/",
      commercial_zone_slug: "nord-arcella",
    });
    expect(out.via_norm).toBeNull();
    expect(out.civico_norm).toBeNull();
  });

  it("rifiuta contesto senza zona", () => {
    expect(() => parseContendibileDetail(
      { data: { markdown: "Via Roma 12. ".repeat(20) } },
      { listing_id: 1, url: "https://example.com/1", commercial_zone_slug: "" },
    )).toThrow("missing_commercial_zone_slug");
  });

  it("il riferimento richiede un'etichetta esplicita", () => {
    expect(extractUnitReference("Rif. immobile PD-381")).toBe("pd-381");
    expect(extractUnitReference("Appartamento 381 metri dal centro")).toBeNull();
  });
});

describe("P1-D — produzione quotidiana isolata", () => {
  it("legge padova_listings usando soltanto colonne esistenti", () => {
    expect(enqueue).toContain(
      '.select("id,url,fonte,agency,commercial_zone_slug,last_seen_at,raw_json,ev_civico_norm,ev_piano_key,ev_descr_fp")',
    );
    expect(enqueue).not.toContain("row.updated_at");
    expect(enqueue).not.toContain("last_seen_at,updated_at");
  });

  it("non accetta URL, zona o privilegi dal body", () => {
    expect(enqueue).not.toMatch(/body\.(url|urls|commercial_zone_slug|is_admin)/);
    expect(enqueue).toContain('.from("padova_contendibili_quarantena")');
    expect(enqueue).toContain(".in(\"url\", allUrls)");
  });

  it("seleziona solo quarantene prive della prova di unità", () => {
    expect(enqueue).toContain('ALLOWED_REASONS = new Set(["CIVICO_ASSENTE", "EVIDENZA_UNITA_ASSENTE"])');
    expect(enqueue).toContain("reasons.every((r) => ALLOWED_REASONS.has(r))");
  });

  it("esclude aste, procedure, MLS ed esclusive prima di spendere", () => {
    expect(enqueue).toMatch(/procedura esecutiva/);
    expect(enqueue).toMatch(/multiple listing service/);
    expect(enqueue).toMatch(/incarico in esclusiva/);
    expect(enqueue).toContain("groupsForbidden++");
  });

  it("ha un tetto giornaliero assoluto e idempotenza per annuncio/giorno", () => {
    expect(enqueue).toContain("const HARD_CAP = 36");
    expect(enqueue).toContain("const DEFAULT_CAP = 24");
    expect(enqueue).toContain("civiko-cont-detail:v1:");
    expect(enqueue).toContain("p_idempotency_key: idem");
  });

  it("usa un processor dedicato senza alterare quello dei portali", () => {
    expect(processor).toContain("padova_portal_collect_v2: async");
    expect(processor).toContain("civiko_contendibile_detail_v1: async");
    expect(processor).toContain('rpc("process_civiko_contendibile_detail_v1"');
  });

  it("la RPC è service-role only e verifica listing, URL e zona", () => {
    expect(migration).toContain("service_role required");
    expect(migration).toContain("listing scope mismatch");
    expect(migration).toContain("attempt scope mismatch");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.process_civiko_contendibile_detail_v1");
  });

  it("un conflitto di civico o piano azzera la prova", () => {
    expect(migration).toMatch(/ev_civico_norm = CASE[\s\S]*ELSE NULL/);
    expect(migration).toMatch(/ev_piano_key = CASE[\s\S]*ELSE NULL/);
  });

  it("nessun URL immagine certifica da solo un immobile", () => {
    expect(migration).toContain("ev_image_refs");
    expect(migration).not.toMatch(/evidence_kind\s*=\s*['"]IMAGE/);
    expect(migration).not.toMatch(/INSERT INTO public\.padova_contendibili/);
  });

  it("il cron usa il secret corretto e precede il recompute autoritativo", () => {
    expect(migration).toContain("WHERE name='CENTRAL_CORE_JOB_SECRET'");
    expect(migration).toContain("'0 4 * * *'");
    expect(migration).not.toContain("cron.unschedule(107)");
  });

  it("non modifica sorgenti o tabelle di altre PWA", () => {
    expect(migration).not.toMatch(/DELETE FROM public\.padova_listings/);
    expect(migration).not.toMatch(/UPDATE public\.(?:keydraft|sottra|core_)/);
    expect(enqueue).not.toMatch(/keydraft|sottra/i);
  });
});
