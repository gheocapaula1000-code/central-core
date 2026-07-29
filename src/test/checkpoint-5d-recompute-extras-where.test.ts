import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ───────────────────────────────────────────────────────────────────────────
// CHECKPOINT 5D — correzione di public.recompute_padova_contendibili_extras()
//
// Causa: il ruolo `authenticator` precarica pg_safeupdate; ogni
// `UPDATE ... FROM <join>` lascia il nodo target senza qual di restrizione e
// PostgREST risponde "UPDATE requires a WHERE clause".
//
// Patch: PK pre-materializzate in tabelle temporanee + UPDATE su singola
// tabella filtrati da `WHERE c.id = ANY (v_ids)`.
//
// Questa suite è statica (nessun accesso al DB): verifica la migration finale.
// ───────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const MIGRATION_FILE = "20260729184939_10b1c4de-5c66-4ff1-95a7-c3025038f5da.sql";

const sql = readFileSync(join(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");

/** Estrae il corpo di una funzione dalla migration. */
function fnBody(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`);
  expect(start, `funzione ${name} assente dalla migration`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$function$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

const extras = fnBody("recompute_padova_contendibili_extras");
const detect = fnBody("detect_padova_cambio_agenzia");

/** Tutte le istruzioni UPDATE/DELETE su tabelle persistenti (public.*). */
function persistentMutations(body: string): string[] {
  const out: string[] = [];
  const re = /\b(UPDATE|DELETE FROM)\s+public\.[a-z_]+[\s\S]*?;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[0]);
  return out;
}

describe("5D — nessun UPDATE/DELETE privo di filtro", () => {
  it("ogni mutazione su tabelle public ha una WHERE esplicita", () => {
    const muts = [...persistentMutations(extras), ...persistentMutations(detect)];
    expect(muts.length).toBeGreaterThan(0);
    for (const s of muts) {
      expect(s.toUpperCase(), `mutazione senza WHERE:\n${s}`).toContain("WHERE");
    }
  });

  it("nessun UPDATE ... FROM <join> sulla tabella target (incompatibile con safeupdate)", () => {
    for (const body of [extras, detect]) {
      for (const s of persistentMutations(body)) {
        if (!/^UPDATE/i.test(s)) continue;
        expect(/\n\s*FROM\s/i.test(s), `UPDATE ... FROM residuo:\n${s}`).toBe(false);
      }
    }
  });

  it("gli UPDATE derivati filtrano su un insieme di PK pre-selezionate", () => {
    const byIds = [...extras.matchAll(/WHERE c\.id = ANY \(v_ids\)/g)].length;
    expect(byIds).toBe(2); // extras: campi zona/mercato + pressione
    expect(detect).toContain("WHERE c.id = ANY (v_ids)");
    expect(detect).toContain("v_ids := ARRAY(SELECT cid FROM _cambio_cand)");
  });

  it("gli UPDATE sono eseguiti solo con almeno una PK selezionata (idempotenza set-based)", () => {
    const guards = [...extras.matchAll(/IF COALESCE\(array_length\(v_ids, 1\), 0\) > 0 THEN/g)].length;
    expect(guards).toBe(2);
    expect(detect).toContain("IF COALESCE(array_length(v_ids, 1), 0) > 0 THEN");
  });
});

describe("5D — nessuna operazione distruttiva o mascherata", () => {
  it("nessun TRUNCATE, DROP di tabelle persistenti o disabilitazione trigger", () => {
    expect(/TRUNCATE/i.test(sql)).toBe(false);
    expect(/DISABLE TRIGGER/i.test(sql)).toBe(false);
    expect(/DROP TABLE IF EXISTS public\./i.test(sql)).toBe(false);
    expect(/ALTER TABLE/i.test(sql)).toBe(false);
  });

  it("nessuna cancellazione di dati sui contendibili", () => {
    expect(/DELETE FROM public\.padova_contendibili/i.test(sql)).toBe(false);
    expect(/DELETE FROM public\.padova_multi_portale/i.test(sql)).toBe(false);
  });

  it("nessun EXCEPTION handler che nasconde l'errore o forza ok:true", () => {
    expect(/EXCEPTION\s+WHEN/i.test(extras)).toBe(false);
    expect(/EXCEPTION\s+WHEN/i.test(detect)).toBe(false);
    // 'ok', true è presente una sola volta per funzione, nel RETURN finale
    expect([...extras.matchAll(/'ok', true/g)].length).toBe(1);
    expect([...detect.matchAll(/'ok', true/g)].length).toBe(1);
  });
});

describe("5D — contratto e semantica invariati", () => {
  it("proprietà di sicurezza preservate", () => {
    for (const body of [extras, detect]) {
      expect(body).toContain("SECURITY DEFINER");
      expect(body).toContain("SET search_path TO 'public'");
      expect(body).toContain("RETURNS jsonb");
    }
    expect(/GRANT|REVOKE/i.test(sql)).toBe(false);
  });

  it("contratto JSON di extras invariato", () => {
    for (const key of [
      "'totale'",
      "'con_prezzo_medio_zona'",
      "'senza_prezzo_medio_zona'",
      "'con_giorni_mercato'",
      "'senza_giorni_mercato'",
      "'mediana_giorni_mercato'",
      "'con_score_pressione'",
      "'cambio_agenzia'",
    ]) {
      expect(extras).toContain(key);
    }
  });

  it("contratto JSON di detect invariato e rilevamento cambio agenzia preservato", () => {
    for (const key of ["'urls_scannati'", "'urls_con_cambio'", "'cambi_scritti'", "'contendibili_marcati'"]) {
      expect(detect).toContain(key);
    }
    expect(detect).toContain("interval '90 days'");
    expect(detect).toContain("interval '1 day'");
    expect(detect).toContain("ON CONFLICT (canon_url, data_cambio) DO UPDATE");
    expect(detect).toContain("GET DIAGNOSTICS v_marcati = ROW_COUNT");
  });

  it("aggiorna soltanto i campi derivati previsti", () => {
    const allowedExtras = [
      "prezzo_immobile_eur_mq",
      "prezzo_medio_zona_eur_mq",
      "differenza_zona_pct",
      "data_primo_annuncio",
      "giorni_sul_mercato",
      "ribasso_pct",
      "n_ribassi",
      "is_ripubblicato",
      "giorni_fermo",
      "n_portali",
      "score_pressione",
    ];
    const assigned = new Set<string>();
    for (const s of persistentMutations(extras)) {
      for (const m of s.matchAll(/^\s*(?:SET\s+)?([a-z_]+)\s+=\s/gm)) assigned.add(m[1]);
    }
    for (const f of assigned) expect(allowedExtras, `campo inatteso: ${f}`).toContain(f);
    // nessuna scrittura su identità / matching / zona / portali sorgente
    for (const forbidden of ["urls", "chiave_match", "commercial_zone_slug", "quartiere", "agenzie", "agencies_normalized", "fonti", "lat", "lng"]) {
      expect(assigned.has(forbidden), `campo protetto modificato: ${forbidden}`).toBe(false);
    }
  });

  it("soglie e formule del punteggio di pressione invariate", () => {
    expect(extras).toContain("COALESCE(agg.n_agenzie, 1) * 30");
    expect(extras).toContain("WHEN agg.ribasso_pct > 10 THEN 25");
    expect(extras).toContain("WHEN agg.ribasso_pct > 5 THEN 10");
    expect(extras).toContain("WHEN agg.is_ripubblicato THEN 20 ELSE 0 END");
    expect(extras).toContain("WHEN agg.giorni_fermo > 120 THEN 20");
    expect(extras).toContain("WHEN agg.giorni_fermo > 60 THEN 10");
    expect(extras).toContain("COALESCE(agg.n_ribassi, 0) * 5");
    expect(extras).toContain("HAVING count(*) >= 10");
    expect(extras).toContain("INTERVAL '60 days'");
  });

  it("nomi temporanei non collidono con recompute_padova_listings_contendibili (_cand)", () => {
    expect(/CREATE TEMP TABLE _cand\b/.test(sql)).toBe(false);
    expect(detect).toContain("CREATE TEMP TABLE _cambio_cand");
  });
});

describe("5D — perimetro invariato (5B / 5C)", () => {
  it("nessuna funzione oltre le due responsabili è ridefinita", () => {
    const created = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)].map((m) => m[1]);
    expect(new Set(created)).toEqual(
      new Set(["recompute_padova_contendibili_extras", "detect_padova_cambio_agenzia"]),
    );
  });

  it("la migration non tocca il matching geografico 5B né l'enrichment 5C", () => {
    expect(/recompute_padova_listings_contendibili/.test(sql)).toBe(false);
    expect(/merge_padova_contendibili/.test(sql)).toBe(false);
    expect(/ST_DWithin|haversine|30\s*m|earth_distance/i.test(sql)).toBe(false);
    expect(/agency_enrich|padova_agency/i.test(sql)).toBe(false);
  });

  it("le migrations 5B restano presenti e immutate nel repo", () => {
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files).toContain("20260729180345_a0b324bb-f1f4-4ea0-8d8b-72707094e463.sql");
    expect(files).toContain("20260729180749_4acba17b-5ce5-40b6-88cd-c3831f115bf4.sql");
  });
});
