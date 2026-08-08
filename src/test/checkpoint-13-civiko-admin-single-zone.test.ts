import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { applyCivikoSingleZoneGate } from "../../supabase/functions/_shared/civikoZoneAccessGate.ts";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const ALL_ZONES = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "nord-est",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
];

describe("P0 — admin owner full-city, agenzie clienti monozona", () => {
  // A) admin owner + x-source-app: civiko
  it("my-zone restituisce admin_full_city anche per richieste Civiko", () => {
    const billing = source("supabase/functions/civiko-billing/index.ts");
    expect(billing).not.toContain("isCivikoRequest");
    expect(billing).toContain("if (isAdmin) {");
    expect(billing).toContain('zona_status: "admin_full_city"');
    expect(billing).toContain("zona_assegnata: null");
    expect(billing).toContain('diagnostics: { scope: "admin_full_city"');
    // il ruolo admin arriva solo da bootstrap verificato o dalla RPC server-side
    expect(billing).toContain("civiko_is_admin_agency");
    expect(billing).toContain("extractVerifiedEmail(req)");
  });

  for (const fn of [
    "civiko-one-signals-feed",
    "padova-contendibili-list",
    "padova-privati-list",
  ]) it(`${fn}: admin owner ottiene le 8 zone senza gate monozona`, () => {
    const file = source(`supabase/functions/${fn}/index.ts`);
    expect(file).toContain("if (isAdmin) {");
    expect(file).not.toContain('isAdmin && !isCivikoSourceApp(req.headers.get("x-source-app"))');
    expect(file).not.toContain('if (isCivikoSourceApp(req.headers.get("x-source-app"))) isAdmin = false');
    expect(file).toContain("if (!isAdmin) {");
    for (const slug of ALL_ZONES) expect(file).toContain(slug);
  });

  it("padova-quartieri-stats: admin owner mantiene le 8 zone", () => {
    const file = source("supabase/functions/padova-quartieri-stats/index.ts");
    expect(file).not.toContain(
      'if (isCivikoSourceApp(req.headers.get("x-source-app"))) isAdmin = false',
    );
    expect(file).toContain("const gate = isAdmin");
    expect(file).toContain("authorizedSlugs = OFFICIAL_ZONES.map((z) => z.slug)");
  });

  // D) ruolo/admin inviato dal client viene ignorato
  for (const fn of [
    "civiko-billing",
    "civiko-one-signals-feed",
    "padova-contendibili-list",
    "padova-privati-list",
    "padova-quartieri-stats",
  ]) it(`${fn} non legge is_admin/role dal client`, () => {
    const file = source(`supabase/functions/${fn}/index.ts`);
    expect(file).not.toMatch(/\bis_admin\b\s*[:=]?[^\n]*(body|searchParams|payload)/);
    expect(file).not.toContain('pickStr("is_admin")');
    expect(file).not.toContain('searchParams.get("is_admin")');
    expect(file).not.toContain('searchParams.get("role")');
  });

  // B/C) contratto monozona per le agenzie clienti (gate puro)
  it("cliente con Centro Storico riceve solo la propria zona", () => {
    const gate = applyCivikoSingleZoneGate("civiko", ["centro-storico"]);
    expect(gate).toEqual({ civiko: true, ok: true, slugs: ["centro-storico"] });
  });

  it("cliente che chiede un'altra zona viene respinto", () => {
    const gate = applyCivikoSingleZoneGate("civiko", ["centro-storico"], "nord-arcella");
    expect(gate).toEqual({ civiko: true, ok: false, code: "ZONE_NOT_ASSIGNED" });
  });

  it("cliente senza zona è fail-closed", () => {
    const gate = applyCivikoSingleZoneGate("civiko", []);
    expect(gate).toEqual({ civiko: true, ok: false, code: "NO_ZONE_ASSIGNED" });
  });
});
