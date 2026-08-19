import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Contratto server-to-server dei 4 job rientrati dal 401:
// - civiko-private-leads-classify
// - civiko-private-leads-price-snapshot
// - civiko-private-leads-nightly
// - padova-portal-scrapes-full -> enqueue-padova-portal-scrapes
const ENDPOINTS = [
  "supabase/functions/civiko-private-leads-classify/index.ts",
  "supabase/functions/civiko-private-leads-price-snapshot/index.ts",
  "supabase/functions/civiko-private-leads-nightly/index.ts",
  "supabase/functions/enqueue-padova-portal-scrapes/index.ts",
];

const read = (p: string) => readFileSync(p, "utf8");

describe("cron job secret contract", () => {
  for (const path of ENDPOINTS) {
    const src = read(path);

    it(`${path}: legge il secret solo dal runtime/Vault`, () => {
      expect(src).toContain('Deno.env.get("CENTRAL_CORE_JOB_SECRET")');
    });

    it(`${path}: autentica tramite header x-job-secret (o jobAuth condiviso)`, () => {
      const usesShared = src.includes('from "../_shared/jobAuth.ts"') &&
        src.includes("isJobSecretAuthorized");
      expect(usesShared || src.includes('headers.get("x-job-secret")')).toBe(true);
    });

    it(`${path}: fail-closed su secret assente/errato`, () => {
      // La guardia deve richiedere secret non vuoto E header corrispondente.
      expect(/!jobSecret|!JOB_SECRET|JOB_SECRET\.length === 0/.test(src)).toBe(true);
      expect(src).toContain("401");
    });

    it(`${path}: non accetta il secret da body o query string`, () => {
      expect(src).not.toMatch(/body\s*[?.]*\.?(job_secret|jobSecret)/);
      expect(src).not.toMatch(/searchParams\.get\(["'](job_secret|secret|x-job-secret)["']\)/);
    });

    it(`${path}: non logga né restituisce il valore del secret`, () => {
      expect(src).not.toMatch(/console\.[a-z]+\([^)]*jobSecret/i);
      expect(src).not.toMatch(/console\.[a-z]+\([^)]*JOB_SECRET/);
      expect(src).not.toMatch(/JSON\.stringify\([^)]*JOB_SECRET/i);
    });

    it(`${path}: nessun secret hardcoded`, () => {
      expect(src).not.toMatch(/C1v1k0C0r3/);
      expect(src).not.toMatch(/central_core_job_secret/);
    });
  }
});
