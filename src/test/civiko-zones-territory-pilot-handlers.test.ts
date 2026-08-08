// P0 territoriale Padova Pilot — test sui VERI handler delle edge function
// civiko-zones-list e civiko-zones-reserve. Nessuna chiamata di rete, nessun
// accesso al DB: le dipendenze DB sono iniettate e devono restare NON invocate
// nei casi respinti dal gate.
import { describe, it, expect, beforeAll } from "vitest";
import {
  handleZonesList,
  OFFICIAL_SLUGS,
  type ZoneRow,
} from "../../supabase/functions/civiko-zones-list/index.ts";
import { handleZonesReserve } from "../../supabase/functions/civiko-zones-reserve/index.ts";
import { CIVIKO_COMMERCIAL_ZONES } from "../../supabase/functions/_shared/civikoCommercialZoneContract.ts";
import {
  commercialZoneForQuartiere,
  PADOVA_QUARTIERI_LABELS_BY_ZONE,
} from "../../supabase/functions/_shared/civikoCommercialZoneByQuartiere.ts";
import { PADOVA_PILOT_AMBIGUOUS_STAZIONE_FIERA_KEYS } from "../../supabase/functions/_shared/civikoTerritoryContractPadovaPilotV1.ts";

const EXPECTED_SLUGS = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "nord-est",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
];

const LEGACY_SLUGS = [
  "palestro-sacra-famiglia",
  "portello-stazione-fiera",
  "madonna-pellegrina-bassanello",
  "arcella-nord-torre",
  "prima-arcella-direzionale",
  "paltana-brusegana-ovest",
  "ponte-brenta-forcellini",
  "camin-zip",
  "sud-rurale",
];

function fakeRows(slugs: readonly string[]): ZoneRow[] {
  return slugs.map((slug, i) => ({
    slug,
    nome: `Zona ${slug}`,
    tier: "standard",
    canone_mese_eur: 1000 + i,
    provvigioni_anno_eur: 20000,
    contendibili_count: 3,
    status: "available",
    trial_reserved_until: null,
    occupied_since: null,
  }));
}

const listReq = () => new Request("http://local/civiko-zones-list", { method: "GET" });

describe("contratto 8 slug ufficiali", () => {
  it("il contratto espone esattamente gli 8 slug", () => {
    expect(CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug).sort()).toEqual([...EXPECTED_SLUGS].sort());
    expect(OFFICIAL_SLUGS).toHaveLength(8);
  });
});

describe("resolver quartiere → zona", () => {
  it("Stazione, Stazione Ferroviaria e Scrovegni → centro-storico", () => {
    for (const q of ["Stazione", "Stazione Ferroviaria", "Scrovegni"]) {
      expect(commercialZoneForQuartiere(q)).toBe("centro-storico");
    }
  });
  it("Fiera → est-brenta", () => {
    expect(commercialZoneForQuartiere("Fiera")).toBe("est-brenta");
  });
  it("stringhe miste Stazione/Fiera → null (fail-closed, nessuno split)", () => {
    const mixed = [
      ...PADOVA_PILOT_AMBIGUOUS_STAZIONE_FIERA_KEYS,
      "Stazione / Fiera",
      "Stazione - Fiera",
      "Stazione Scrovegni C.so del Popolo Fiera Cittadella",
    ];
    for (const q of mixed) expect(commercialZoneForQuartiere(q)).toBeNull();
  });
  it("slug legacy misti non sono risolti", () => {
    for (const s of LEGACY_SLUGS) expect(commercialZoneForQuartiere(s)).toBeNull();
  });
});

describe("handler reale civiko-zones-list", () => {
  let body: {
    ok: boolean;
    data: { zones: Array<Record<string, unknown>>; count: number };
  };

  beforeAll(async () => {
    const res = await handleZonesList(listReq(), async () => ({
      rows: fakeRows(EXPECTED_SLUGS),
      error: null,
    }));
    expect(res.status).toBe(200);
    body = await res.json();
  });

  it("restituisce esattamente 8 zone con gli slug ufficiali", () => {
    expect(body.ok).toBe(true);
    expect(body.data.count).toBe(8);
    expect(body.data.zones.map((z) => z.slug).sort()).toEqual([...EXPECTED_SLUGS].sort());
  });

  it("nessuno slug legacy nella risposta", () => {
    const json = JSON.stringify(body);
    for (const s of LEGACY_SLUGS) expect(json).not.toContain(s);
  });

  it("11B-A: tutte e 8 le zone sono selezionabili dal catalogo", () => {
    expect(body.data.zones).toHaveLength(8);
    for (const z of body.data.zones) {
      expect(z.selectable).toBe(true);
      expect(z.availability_action).toBe("verify");
    }
  });

  it("Stazione compare una sola volta, sotto Centro Storico", () => {
    const hits = body.data.zones.filter((z) =>
      (z.quartieri_principali as string[]).some((q) => q.toLowerCase() === "stazione"),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].slug).toBe("centro-storico");
  });

  it("Fiera compare una sola volta, sotto Est-Brenta", () => {
    const hits = body.data.zones.filter((z) =>
      (z.quartieri_principali as string[]).some((q) => q.toLowerCase() === "fiera"),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].slug).toBe("est-brenta");
  });

  it("nessuna etichetta quartiere mista Stazione+Fiera", () => {
    for (const list of Object.values(PADOVA_QUARTIERI_LABELS_BY_ZONE)) {
      for (const label of list) {
        const l = label.toLowerCase();
        expect(l.includes("stazione") && l.includes("fiera")).toBe(false);
      }
    }
  });

  it("fail-closed se il DB non restituisce esattamente gli 8 slug", async () => {
    const res = await handleZonesList(listReq(), async () => ({
      rows: fakeRows([...EXPECTED_SLUGS.slice(0, 7), "portello-stazione-fiera"]),
      error: null,
    }));
    expect(res.status).toBe(500);
    const b = await res.json();
    expect(b.ok).toBe(false);
    expect(b.error.code).toBe("TERRITORY_CONTRACT_VIOLATION");
  });
});

describe("handler reale civiko-zones-reserve — gate territoriale", () => {
  const SECRET = "test-job-secret";
  const WS = "11111111-2222-3333-4444-555555555555";
  const USER = "66666666-7777-8888-9999-000000000000";

  beforeAll(() => {
    process.env.CENTRAL_CORE_JOB_SECRET = SECRET;
    process.env.SUPABASE_URL = "http://db.local";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  });

  function req(slug: unknown) {
    return new Request("http://local/civiko-zones-reserve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-job-secret": SECRET,
        "x-workspace-id": WS,
        "x-user-id": USER,
      },
      body: JSON.stringify({ slug }),
    });
  }

  /** Client fittizio: qualunque accesso DB viene registrato e interrompe il flusso. */
  function spyFactory(rpcResult: { data: unknown; error: unknown } = {
    data: { ok: true, slug: "centro-storico" },
    error: null,
  }) {
    const calls: string[] = [];
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => {
        calls.push("select");
        return { data: { id: WS }, error: null };
      },
      insert: async () => {
        calls.push("insert");
        return { error: null };
      },
      upsert: async () => {
        calls.push("upsert");
        return { error: null };
      },
    };
    const client = {
      from: (t: string) => {
        calls.push(`from:${t}`);
        return query;
      },
      rpc: async (fn: string) => {
        calls.push(`rpc:${fn}`);
        return rpcResult;
      },
    };
    const factory = () => {
      calls.push("createClient");
      return client;
    };
    return { calls, factory };
  }

  it("centro-storico supera il gate e arriva allo step DB", async () => {
    const { calls, factory } = spyFactory();
    const res = await handleZonesReserve(req("centro-storico"), factory);
    expect(calls).toContain("createClient");
    expect(calls).toContain("rpc:reserve_padova_pilot_zone_atomic");
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.ok).toBe(true);
  });

  it("11B-A: tutti e 8 gli slug ufficiali sono prenotabili via RPC atomica", async () => {
    for (const slug of EXPECTED_SLUGS) {
      const { calls, factory } = spyFactory({ data: { ok: true, slug }, error: null });
      const res = await handleZonesReserve(req(slug), factory);
      expect(res.status).toBe(200);
      expect(calls).toContain("rpc:reserve_padova_pilot_zone_atomic");
    }
  });

  it("slug legacy e manipolati ricevono 404 senza insert/upsert/RPC", async () => {
    const bad = [...LEGACY_SLUGS, "CENTRO-STORICO", "centro storico", "fiera", "stazione-fiera"];
    for (const slug of bad) {
      const { calls, factory } = spyFactory();
      const res = await handleZonesReserve(req(slug), factory);
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    }
  });

  it("slug mancante → 400 senza toccare il DB", async () => {
    const { calls, factory } = spyFactory();
    const res = await handleZonesReserve(req(""), factory);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("handler reale civiko-zones-reserve — esito applicativo RPC", () => {
  const SECRET = "test-job-secret";
  const WS = "11111111-2222-3333-4444-555555555555";
  const USER = "66666666-7777-8888-9999-000000000000";

  beforeAll(() => {
    process.env.CENTRAL_CORE_JOB_SECRET = SECRET;
    process.env.SUPABASE_URL = "http://db.local";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  });

  function req(workspace = WS) {
    return new Request("http://local/civiko-zones-reserve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-job-secret": SECRET,
        "x-workspace-id": workspace,
        "x-user-id": USER,
      },
      body: JSON.stringify({ slug: "centro-storico" }),
    });
  }

  function clientWith(rpcResult: { data: unknown; error: unknown }) {
    const calls: string[] = [];
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: { id: WS }, error: null }),
      insert: async () => ({ error: null }),
      upsert: async () => ({ error: null }),
    };
    const client = {
      from: () => query,
      rpc: async (fn: string) => {
        calls.push(`rpc:${fn}`);
        return rpcResult;
      },
    };
    return { calls, factory: () => client };
  }

  it("data.ok === true → 200 successo", async () => {
    const { factory } = clientWith({ data: { ok: true, slug: "centro-storico" }, error: null });
    const res = await handleZonesReserve(req(), factory);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  const negatives: Array<[string, number]> = [
    ["zona_in_trial", 409],
    ["zona_occupata", 409],
    ["agency_ha_gia_zona", 409],
    ["zona_non_trovata", 404],
  ];

  for (const [code, status] of negatives) {
    it(`data.ok === false (${code}) → risposta non riuscita, mai successo`, async () => {
      const { calls, factory } = clientWith({ data: { ok: false, error: code }, error: null });
      const res = await handleZonesReserve(req(), factory);
      expect(res.status).toBe(status);
      const b = await res.json();
      expect(b.ok).toBe(false);
      expect(b.error.code).toBe(code);
      // nessuna RPC ulteriore dopo l'esito negativo
      expect(calls.filter((c) => c.startsWith("rpc:"))).toHaveLength(1);
    });
  }

  it("data null con error null → fail-closed 500", async () => {
    const { factory } = clientWith({ data: null, error: null });
    const res = await handleZonesReserve(req(), factory);
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });

  it("payload senza booleano ok → fail-closed 500", async () => {
    const { factory } = clientWith({ data: { slug: "centro-storico" }, error: null });
    const res = await handleZonesReserve(req(), factory);
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });

  it("due workspace in sequenza: esattamente una risposta riuscita", async () => {
    const first = await handleZonesReserve(
      req("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
      clientWith({ data: { ok: true, slug: "centro-storico" }, error: null }).factory,
    );
    const second = await handleZonesReserve(
      req("bbbbbbbb-cccc-dddd-eeee-ffffffffffff"),
      clientWith({ data: { ok: false, error: "zona_in_trial" }, error: null }).factory,
    );
    const bodies = [await first.json(), await second.json()];
    expect(bodies.filter((b) => b.ok === true)).toHaveLength(1);
    expect(bodies[1].error.code).toBe("zona_in_trial");
    expect(second.status).toBe(409);
  });
});
