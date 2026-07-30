import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("Checkpoint 13 — admin Civiko resta monozona", () => {
  it("my-zone non applica admin_full_city alle richieste Civiko", () => {
    const billing = source("supabase/functions/civiko-billing/index.ts");
    expect(billing).toContain(
      'const isCivikoRequest = isCivikoSourceApp(req.headers.get("x-source-app"))',
    );
    expect(billing).toContain("if (isAdmin && !isCivikoRequest)");
  });

  it.each([
    "civiko-one-signals-feed",
    "padova-contendibili-list",
    "padova-privati-list",
  ])("%s usa l'assegnazione reale anche per l'admin Civiko", (fn) => {
    const file = source(`supabase/functions/${fn}/index.ts`);
    expect(file).toContain(
      'isAdmin && !isCivikoSourceApp(req.headers.get("x-source-app"))',
    );
  });

  it("le statistiche Quartieri disattivano il full-city per Civiko", () => {
    const file = source("supabase/functions/padova-quartieri-stats/index.ts");
    expect(file).toContain(
      'if (isCivikoSourceApp(req.headers.get("x-source-app"))) isAdmin = false',
    );
  });
});
