// Regressione mapping 4 portali: guard comune fail-closed prima di ogni upsert.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mapCasa, mapIdealista, mapImmoDetail, mapImmoListview, mapSubito, isScopeReject } from "./mappers.ts";

const JOB = "test-job";
const NOW = "2026-08-06T00:00:00.000Z";

Deno.test("subito: item Vigonza rifiutato, nessuna riga costruita", () => {
  const out = mapSubito({
    page_url: "https://www.subito.it/appartamenti/casa-123.htm",
    type: "vendita",
    price: { value: 190000 },
    location: { city: "Vigonza", province: "Padova" },
  }, JOB, NOW);
  assertEquals(out.ok, false);
  assert(isScopeReject((out as any).code));
  assertEquals((out as any).code, "COMUNE_OUT_OF_SCOPE");
});

Deno.test("subito: item senza città rifiutato", () => {
  const out = mapSubito({
    page_url: "https://www.subito.it/appartamenti/casa-124.htm",
    type: "vendita",
    price: { value: 190000 },
    location: { province: "Padova" },
  }, JOB, NOW);
  assertEquals((out as any).code, "COMUNE_MISSING");
});

Deno.test("subito: item Padova accettato con citta='Padova'", () => {
  const out = mapSubito({
    page_url: "https://www.subito.it/appartamenti/casa-125.htm",
    type: "vendita",
    price: { value: 190000 },
    location: { city: "Padova", province: "Padova" },
  }, JOB, NOW);
  assert(out.ok);
  assertEquals((out as any).row.citta, "Padova");
  assertEquals((out as any).row.portal, "subito");
});

Deno.test("casa: Selvazzano rifiutato, Padova accettato", () => {
  const base = { url: "https://www.casa.it/immobili/1", channel: "sale", price: 250000, id: 1 };
  assertEquals((mapCasa({ ...base, city: "Selvazzano Dentro" }, JOB, NOW) as any).code, "COMUNE_OUT_OF_SCOPE");
  assertEquals((mapCasa({ ...base, city: undefined }, JOB, NOW) as any).code, "COMUNE_MISSING");
  const ok = mapCasa({ ...base, city: "Padova" }, JOB, NOW);
  assert(ok.ok);
  assertEquals((ok as any).row.citta, "Padova");
});

Deno.test("idealista: comune fuori perimetro o mancante rifiutato", () => {
  const base = {
    propertyId: 42,
    originalUrl: "https://www.idealista.it/immobile/42/",
    price: 300000,
    ubication: {},
  };
  assertEquals((mapIdealista(base, JOB, NOW) as any).code, "COMUNE_MISSING");
  assertEquals(
    (mapIdealista({ ...base, ubication: { municipality: "Abano Terme" } }, JOB, NOW) as any).code,
    "COMUNE_OUT_OF_SCOPE",
  );
  const ok = mapIdealista({ ...base, ubication: { municipality: "Padova" } }, JOB, NOW);
  assert(ok.ok);
  assertEquals((ok as any).row.citta, "Padova");
});

Deno.test("immobiliare detail/listview: guard comune applicata", () => {
  const detailBase = { shareUrl: "https://www.immobiliare.it/annunci/99/", price: { raw: 400000 }, _enhanced: {} };
  assertEquals((mapImmoDetail(detailBase, JOB, NOW) as any).code, "COMUNE_MISSING");
  assertEquals(
    (mapImmoDetail({ ...detailBase, geography: { city: "Limena" } }, JOB, NOW) as any).code,
    "COMUNE_OUT_OF_SCOPE",
  );
  assert(mapImmoDetail({ ...detailBase, geography: { city: "Padova" } }, JOB, NOW).ok);

  const lvBase = { id: 77, directLink: "https://www.immobiliare.it/annunci/77", price: { value: 200000 } };
  assertEquals((mapImmoListview(lvBase, JOB, NOW) as any).code, "COMUNE_MISSING");
  assertEquals(
    (mapImmoListview({ ...lvBase, properties: [{ isMain: true, location: { city: "Vigonza" } }] }, JOB, NOW) as any).code,
    "COMUNE_OUT_OF_SCOPE",
  );
  const okLv = mapImmoListview(
    { ...lvBase, properties: [{ isMain: true, location: { city: "Padova" } }] }, JOB, NOW,
  );
  assert(okLv.ok);
  assertEquals((okLv as any).row.citta, "Padova");
});

Deno.test("promozione SQL: guard comune fail-closed nella migration forward", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260806194355_3b6e0836-349c-4dc4-b417-11634ca16bfe.sql", import.meta.url),
  );
  assert(sql.includes("civiko_is_comune_padova"));
  assert(!sql.includes("lower(coalesce(citta,'')) = 'padova'"));
  assert(sql.includes("out_of_scope_written"));
  // nessuna cancellazione delle righe storiche
  assert(!/\bDELETE\s+FROM\b/i.test(sql));
});
