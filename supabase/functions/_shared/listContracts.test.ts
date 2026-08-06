import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  listEnvelope,
  nullableText,
  pageWindow,
  parseZoneSlug,
  resolveTenantScope,
  snapshotComplete,
} from "./listContracts.ts";

Deno.test("slug: solo match esatto nelle 8 zone, wildcard rifiutate", () => {
  assertEquals(parseZoneSlug("centro-storico"), { ok: true, slug: "centro-storico" });
  assertEquals(parseZoneSlug("centro%"), { ok: false, code: "SLUG_OUT_OF_CONTRACT" });
  assertEquals(parseZoneSlug("centro_storico"), { ok: false, code: "SLUG_OUT_OF_CONTRACT" });
  assertEquals(parseZoneSlug("%"), { ok: false, code: "SLUG_OUT_OF_CONTRACT" });
  assertEquals(parseZoneSlug("zona-inesistente"), { ok: false, code: "SLUG_OUT_OF_CONTRACT" });
  assertEquals(parseZoneSlug(null), { ok: false, code: "SLUG_OUT_OF_CONTRACT" });
});

Deno.test("tenant: vede solo la zona assegnata, full-city vietato", () => {
  assertEquals(
    resolveTenantScope({ isAdmin: false, assignedSlugs: ["nord-arcella"] }),
    { ok: true, slugs: ["nord-arcella"], full_city: false },
  );
  assertEquals(
    resolveTenantScope({ isAdmin: false, assignedSlugs: ["nord-arcella"], requestedSlug: "centro-storico" }),
    { ok: false, code: "ZONE_NOT_ASSIGNED" },
  );
  assertEquals(
    resolveTenantScope({ isAdmin: false, assignedSlugs: [] }),
    { ok: false, code: "NO_ZONE_ASSIGNED" },
  );
  assertEquals(
    resolveTenantScope({ isAdmin: false, assignedSlugs: ["nord-arcella", "est-brenta"] }),
    { ok: false, code: "FULL_CITY_FORBIDDEN" },
  );
});

Deno.test("admin: full-city sulle 8 zone, restringibile a una zona", () => {
  const all = resolveTenantScope({ isAdmin: true, assignedSlugs: [] });
  assertEquals(all.ok, true);
  if (all.ok) {
    assertEquals(all.slugs.length, 8);
    assertEquals(all.full_city, true);
  }
  assertEquals(
    resolveTenantScope({ isAdmin: true, assignedSlugs: [], requestedSlug: "est-brenta" }),
    { ok: true, slugs: ["est-brenta"], full_city: false },
  );
});

Deno.test("paginazione: offset oltre il totale ⇒ pagina vuota, nessun clamp", () => {
  const p = pageWindow("50", "500", 120, 200, 50);
  assertEquals(p.beyond_eof, true);
  assertEquals(p.offset, 500);
  const env = listEnvelope({ items: [], total: 120, limit: p.limit, offset: p.offset, snapshot_complete: true });
  assertEquals(env.items, []);
  assertEquals(env.has_more, false);
  assertEquals(env.total, 120);
});

Deno.test("paginazione: pagine multiple su dataset > limit", () => {
  const p1 = pageWindow("50", "0", 120, 200, 50);
  assertEquals([p1.from, p1.to, p1.beyond_eof], [0, 49, false]);
  const p2 = pageWindow("50", "100", 120, 200, 50);
  assertEquals([p2.from, p2.to, p2.beyond_eof], [100, 149, false]);
  const env = listEnvelope({
    items: new Array(20).fill(0),
    total: 120,
    limit: p2.limit,
    offset: p2.offset,
    snapshot_complete: true,
  });
  assertEquals(env.has_more, false);
  assertEquals(env.items_count, 20);
  assertEquals(env.data.total, 120);
});

Deno.test("snapshot_complete: indipendente da items.length, falso se troncato", () => {
  assertEquals(snapshotComplete({ countExact: true, truncated: false }), true);
  assertEquals(snapshotComplete({ countExact: true, truncated: true }), false);
  assertEquals(snapshotComplete({ countExact: false, truncated: false }), false);
  const env = listEnvelope({ items: [1], total: 999, limit: 50, offset: 0, snapshot_complete: true });
  assertEquals(env.snapshot_complete, true);
  assertEquals(env.data.snapshot_complete, true);
});

Deno.test("nessun placeholder: testo assente resta null", () => {
  assertEquals(nullableText("  "), null);
  assertEquals(nullableText(null), null);
  assertEquals(nullableText("Via Roma"), "Via Roma");
});

Deno.test("envelope: stessi campi a livello top e dentro data", () => {
  const env = listEnvelope({ items: [1, 2], total: 5, limit: 2, offset: 0, snapshot_complete: false });
  for (const k of ["items", "total", "items_count", "limit", "offset", "has_more", "snapshot_complete"]) {
    assertEquals(
      (env as unknown as Record<string, unknown>)[k],
      (env.data as unknown as Record<string, unknown>)[k],
    );
  }
  assertEquals(env.has_more, true);
});
