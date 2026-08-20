// Checkpoint 2 — riproducibilità DB e deploy Civiko One (test statici)
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const FUNCTIONS_DIR = path.join(ROOT, "supabase/functions");
const CONFIG_PATH = path.join(ROOT, "supabase/config.toml");
const MANIFEST_PATH = path.join(ROOT, "supabase/civiko-one-deploy-manifest.json");

const CIVIKO_ONE_FUNCTIONS = [
  "civiko-zones-list",
  "civiko-zones-reserve",
  "civiko-billing",
  "padova-contendibili-list",
  "padova-quartieri-stats",
  "padova-privati-list",
  "core-offmarket-list-public",
  "civiko-one-signals-feed",
  "civiko-radar-veneto",
  "civiko-property-from-photo",
  "property-marketing-pack",
  "property-outputs",
  "civiko-property-owner-report",
] as const;

const LEGACY_ORPHAN_CONFIG_BLOCKS = [
  "civiko-admin-secrets",
  "demo-agency-opportunities",
  "demo-territory-records",
  "luxuradar-scan",
  "fetch-albo-pretorio",
  "fetch-aste-nascoste",
  "run-apify-blacklist",
  "run-firecrawl-albo",
];

const STANDALONE_ENGINES = ["keydraft", "sottra", "wyloni", "regiads", "viral-core"];

const migrations = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const configText = fs.readFileSync(CONFIG_PATH, "utf8");
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

function configVerifyJwt(name: string): string | null {
  const re = new RegExp(`^\\[functions\\.${name.replace(/[-.]/g, "\\$&")}\\]\\s*\\n(?:[^[]*?)verify_jwt\\s*=\\s*(true|false)`, "m");
  const m = configText.match(re);
  return m ? m[1] : null;
}

describe("Checkpoint 2 — migrations", () => {
  it("tutti i nomi migration sono conformi", () => {
    for (const f of migrations) expect(f).toMatch(/^\d{14}_[\w.-]+\.sql$/);
  });

  it("nessun timestamp migration duplicato", () => {
    const versions = migrations.map((f) => f.slice(0, 14));
    // Already applied on main: five 2026-08-19 18:00 jobs share a prefix.
    // New files (including TrovaBandi) must still pick a unique 14-digit stamp.
    const KNOWN_MAIN_COLLISION = "20260819180000";
    expect(versions.filter((v) => v === KNOWN_MAIN_COLLISION)).toHaveLength(5);
    const rest = versions.filter((v) => v !== KNOWN_MAIN_COLLISION);
    expect(new Set(rest).size).toBe(rest.length);
  });

  it("la migration repo-only superseded è stata rimossa", () => {
    expect(
      fs.existsSync(path.join(MIGRATIONS_DIR, "20260628101200_fix_padova_contendibili_recompute_fallback.sql")),
    ).toBe(false);
    expect(migrations.some((f) => f.startsWith("20260628101200"))).toBe(false);
  });

  it("una migration registrata elimina l'overload con parametro text", () => {
    const dropper = migrations.find((f) => f.startsWith("20260628134356"));
    expect(dropper).toBeTruthy();
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, dropper as string), "utf8");
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.recompute_padova_contendibili(text)");
  });
});

describe("Checkpoint 2 — perimetro funzioni Civiko One", () => {
  it("le 13 directory esistono con index.ts", () => {
    for (const fn of CIVIKO_ONE_FUNCTIONS) {
      expect(fs.existsSync(path.join(FUNCTIONS_DIR, fn, "index.ts")), fn).toBe(true);
    }
  });

  it("verify_jwt è esplicito in config.toml per tutte le 13", () => {
    for (const fn of CIVIKO_ONE_FUNCTIONS) {
      expect(configVerifyJwt(fn), fn).not.toBeNull();
    }
  });

  it("nessun blocco [functions.*] duplicato", () => {
    const blocks = [...configText.matchAll(/^\[functions\.([^\]]+)\]/gm)].map((m) => m[1]);
    expect(new Set(blocks).size).toBe(blocks.length);
  });
});

describe("Checkpoint 2 — manifest di deploy selettivo", () => {
  it("deploy_mode è selective_only e vieta il deploy globale", () => {
    expect(manifest.deploy_mode).toBe("selective_only");
    expect(manifest.global_deploy_forbidden).toBe(true);
  });

  it("contiene esattamente le 13 funzioni, una sola volta, nell'ordine atteso", () => {
    const names = manifest.functions.map((f: { name: string }) => f.name);
    expect(names).toEqual([...CIVIKO_ONE_FUNCTIONS]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("manifest e config.toml concordano su verify_jwt", () => {
    for (const f of manifest.functions) {
      expect(String(f.verify_jwt), f.name).toBe(configVerifyJwt(f.name));
    }
  });

  it("le modalità auth sono quelle dichiarate dal contratto", () => {
    const byName = Object.fromEntries(manifest.functions.map((f: { name: string; auth_mode: string }) => [f.name, f.auth_mode]));
    expect(byName["civiko-zones-list"]).toBe("public_read");
    expect(byName["core-offmarket-list-public"]).toBe("public_read");
    expect(byName["civiko-zones-reserve"]).toBe("custom_job_secret");
    expect(byName["civiko-property-owner-report"]).toBe("proxy_member_only_no_core_secret");
    for (const fn of CIVIKO_ONE_FUNCTIONS) {
      expect(Object.keys(manifest.auth_modes)).toContain(byName[fn]);
    }
  });

  it("nessun motore standalone nel manifest", () => {
    const raw = JSON.stringify(manifest.functions).toLowerCase();
    for (const engine of STANDALONE_ENGINES) expect(raw).not.toContain(engine);
  });

  it("nessun config orphan legacy nel manifest", () => {
    const names = manifest.functions.map((f: { name: string }) => f.name);
    for (const orphan of LEGACY_ORPHAN_CONFIG_BLOCKS) expect(names).not.toContain(orphan);
  });

  it("nessun valore di secret, URL privato o token nel manifest", () => {
    const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // JWT
    expect(raw).not.toMatch(/sk_(live|test)_/);
    expect(raw).not.toMatch(/https?:\/\/[a-z0-9-]+\.supabase\.(co|in)/i);
    expect(raw).not.toMatch(/(apify_api_|fc-|pplx-)/);
    for (const f of manifest.functions) {
      for (const s of f.required_secrets as string[]) {
        expect(s).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it("nessuna istruzione di deploy globale", () => {
    const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
    expect(raw).not.toContain("deploy --all");
    expect(raw).not.toContain("--all");
  });
});
