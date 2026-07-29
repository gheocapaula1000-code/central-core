// CHECKPOINT 4A — prenotazione Core atomica e idempotente.
// Test puri sull'handler reale: nessuna rete, nessun DB, nessun cron.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { handleZonesReserve } from "../../supabase/functions/civiko-zones-reserve/index.ts";
import { CIVIKO_COMMERCIAL_ZONES } from "../../supabase/functions/_shared/civikoCommercialZoneContract.ts";
import { commercialZoneForQuartiere } from "../../supabase/functions/_shared/civikoCommercialZoneByQuartiere.ts";
import { PADOVA_PILOT_AMBIGUOUS_STAZIONE_FIERA_KEYS } from "../../supabase/functions/_shared/civikoTerritoryContractPadovaPilotV1.ts";

const SECRET = "test-job-secret-4a";
const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";

const OFFICIAL = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "est-forcellini-camin",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
];

const EDGE_SRC = readFileSync(
  resolve(process.cwd(), "supabase/functions/civiko-zones-reserve/index.ts"),
  "utf-8",
);

function req(slug: unknown, workspace = WS_A, email?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-job-secret": SECRET,
    "x-workspace-id": workspace,
    "x-user-id": USER_A,
  };
  if (email) headers["x-user-email"] = email;
  return new Request("http://local/civiko-zones-reserve", {
    method: "POST",
    headers,
    body: JSON.stringify({ slug }),
  });
}

/**
 * Simulatore della RPC atomica: unica superficie di scrittura.
 * Qualunque uso di `from()` (agenzie/membership separate) viene registrato
 * come violazione del contratto 4A.
 */
function makeDb(seed?: {
  zoneOwner?: string;
  zoneUntil?: string;
  membershipRole?: string;
  membershipStatus?: string;
  membershipMissing?: boolean;
  otherAgencyMembership?: boolean;
}) {
  const state = {
    agencies: new Set<string>(),
    memberships: new Map<string, { role: string; status: string }>(),
    zoneOwner: (seed?.zoneOwner ?? null) as string | null,
    zoneUntil: (seed?.zoneUntil ?? null) as string | null,
  };
  const calls: string[] = [];
  if (seed?.zoneOwner) state.agencies.add(seed.zoneOwner);
  if (seed?.membershipRole) {
    state.memberships.set(`${WS_A}:${USER_A}`, {
      role: seed.membershipRole,
      status: seed.membershipStatus ?? "active",
    });
  }
  if (seed?.otherAgencyMembership) {
    state.memberships.set(`${WS_B}:${USER_A}`, { role: "owner", status: "active" });
  }

  const client = {
    from: (t: string) => {
      calls.push(`from:${t}`);
      throw new Error("accesso diretto alle tabelle non consentito in 4A");
    },
    // deno-lint-ignore no-explicit-any
    rpc: async (fn: string, args: any) => {
      calls.push(`rpc:${fn}`);
      if (fn !== "reserve_padova_pilot_zone_atomic") {
        return { data: null, error: { message: "unknown rpc" } };
      }
      const agency = args.p_agency_id as string;
      const user = args.p_user_id as string;
      const key = `${agency}:${user}`;

      // il perdente non crea nulla
      if (state.zoneOwner && state.zoneOwner !== agency) {
        return { data: { ok: false, error: "zona_in_trial" }, error: null };
      }
      const already = state.zoneOwner === agency;

      // coerenza membership: eseguita SEMPRE, anche nel retry idempotente
      const existing = state.memberships.get(key);
      if (!existing) {
        const conflict = [...state.memberships.entries()].some(
          ([k, v]) => k.endsWith(`:${user}`) && !k.startsWith(`${agency}:`) && v.status === "active",
        );
        if (conflict) return { data: { ok: false, error: "membership_incompatibile" }, error: null };
        state.agencies.add(agency);
        state.memberships.set(key, { role: "owner", status: "active" });
      } else if (existing.role !== "owner") {
        return { data: { ok: false, error: "membership_incompatibile" }, error: null };
      } else if (existing.status !== "active") {
        state.memberships.set(key, { role: "owner", status: "active" });
      }

      if (already) {
        // trial_until NON viene rinnovato
        return {
          data: {
            ok: true,
            already_mine: true,
            zona: "centro-storico",
            status: "in_trial",
            trial_until: state.zoneUntil,
          },
          error: null,
        };
      }

      state.agencies.add(agency);
      state.zoneOwner = agency;
      state.zoneUntil = new Date(Date.now() + 7 * 86400_000).toISOString();
      return {
        data: {
          ok: true,
          already_mine: false,
          zona: "centro-storico",
          status: "in_trial",
          trial_until: state.zoneUntil,
        },
        error: null,
      };
    },
  };
  return { state, calls, factory: () => client };
}


function staticDb(rpcResult: { data: unknown; error: unknown }) {
  const calls: string[] = [];
  const client = {
    from: (t: string) => {
      calls.push(`from:${t}`);
      throw new Error("accesso diretto alle tabelle non consentito in 4A");
    },
    rpc: async (fn: string) => {
      calls.push(`rpc:${fn}`);
      return rpcResult;
    },
  };
  return { calls, factory: () => client };
}

beforeAll(() => {
  process.env.CENTRAL_CORE_JOB_SECRET = SECRET;
  process.env.SUPABASE_URL = "http://db.local";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
});

describe("4A — gate territoriale invariato", () => {
  it("centro-storico passa il gate e produce una sola chiamata RPC", async () => {
    const db = makeDb();
    const res = await handleZonesReserve(req("centro-storico"), db.factory);
    expect(res.status).toBe(200);
    expect(db.calls).toEqual(["rpc:reserve_padova_pilot_zone_atomic"]);
  });

  it("gli altri 7 slug ufficiali sono respinti prima di creare il client DB", async () => {
    for (const slug of OFFICIAL.filter((s) => s !== "centro-storico")) {
      const db = makeDb();
      const res = await handleZonesReserve(req(slug), db.factory);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("pilot_zone_locked");
      expect(db.calls).toHaveLength(0);
    }
  });

  it("slug legacy, manipolati e Stazione/Fiera respinti senza query né scritture", async () => {
    const bad = [
      "arcella",
      "portello-stazione-stanga",
      "CENTRO-STORICO",
      "centro storico",
      "stazione",
      "fiera",
      "stazione-fiera",
    ];
    for (const slug of bad) {
      const db = makeDb();
      const res = await handleZonesReserve(req(slug), db.factory);
      expect(res.status).toBe(403);
      expect(db.calls).toHaveLength(0);
    }
  });
});

describe("4A — atomicità e idempotenza", () => {
  it("prima prenotazione workspace A: successo, already_mine false, una sola agenzia/membership/assegnazione", async () => {
    const db = makeDb();
    const res = await handleZonesReserve(req("centro-storico", WS_A), db.factory);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.already_mine).toBe(false);
    expect(db.state.agencies.size).toBe(1);
    expect(db.state.memberships.size).toBe(1);
    expect(db.state.zoneOwner).toBe(WS_A);
    expect(db.calls.filter((c) => c.startsWith("from:"))).toHaveLength(0);
  });

  it("retry identico workspace A: already_mine true, stessa scadenza, nessuna nuova riga", async () => {
    const db = makeDb();
    const first = await (await handleZonesReserve(req("centro-storico", WS_A), db.factory)).json();
    const agencies = db.state.agencies.size;
    const memberships = db.state.memberships.size;
    const second = await (await handleZonesReserve(req("centro-storico", WS_A), db.factory)).json();
    expect(second.ok).toBe(true);
    expect(second.already_mine).toBe(true);
    expect(second.data.trial_until).toBe(first.data.trial_until); // trial non esteso
    expect(db.state.agencies.size).toBe(agencies);
    expect(db.state.memberships.size).toBe(memberships);
  });

  it("workspace B sulla stessa zona: fallimento coerente e nessuna riga orfana", async () => {
    const db = makeDb();
    await handleZonesReserve(req("centro-storico", WS_A), db.factory);
    const res = await handleZonesReserve(req("centro-storico", WS_B), db.factory);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("zona_in_trial");
    expect(db.state.agencies.has(WS_B)).toBe(false);
    expect([...db.state.memberships.keys()].some((k) => k.startsWith(WS_B))).toBe(false);
    expect(db.state.zoneOwner).toBe(WS_A);
  });

  it("membership con ruolo incompatibile: fail-closed, nessuna prenotazione silenziosa", async () => {
    const db = makeDb({ membershipRole: "viewer" });
    const res = await handleZonesReserve(req("centro-storico", WS_A), db.factory);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("membership_incompatibile");
    expect(db.state.zoneOwner).toBeNull();
  });
});

describe("4A — micro-correzione: coerenza membership nel retry idempotente", () => {
  const NOW_UNTIL = new Date(Date.now() + 5 * 86400_000).toISOString();

  it("retry con membership già presente: already_mine true, stesso trial_until, nessuna nuova riga", async () => {
    const db = makeDb({ zoneOwner: WS_A, zoneUntil: NOW_UNTIL, membershipRole: "owner" });
    const agencies = db.state.agencies.size;
    const memberships = db.state.memberships.size;
    const body = await (await handleZonesReserve(req("centro-storico", WS_A), db.factory)).json();
    expect(body.ok).toBe(true);
    expect(body.already_mine).toBe(true);
    expect(body.data.trial_until).toBe(NOW_UNTIL);
    expect(db.state.zoneUntil).toBe(NOW_UNTIL);
    expect(db.state.agencies.size).toBe(agencies);
    expect(db.state.memberships.size).toBe(memberships);
  });

  it("retry con membership owner mancante: membership creata nella stessa transazione, trial invariato", async () => {
    const db = makeDb({ zoneOwner: WS_A, zoneUntil: NOW_UNTIL });
    expect(db.state.memberships.size).toBe(0);
    const body = await (await handleZonesReserve(req("centro-storico", WS_A), db.factory)).json();
    expect(body.ok).toBe(true);
    expect(body.already_mine).toBe(true);
    expect(body.data.trial_until).toBe(NOW_UNTIL);
    expect(db.state.memberships.get(`${WS_A}:${USER_A}`)).toEqual({ role: "owner", status: "active" });
    expect(db.state.zoneUntil).toBe(NOW_UNTIL);
    expect(db.calls).toEqual(["rpc:reserve_padova_pilot_zone_atomic"]);
  });

  it("retry con membership owner inattiva: riattivata, trial invariato", async () => {
    const db = makeDb({
      zoneOwner: WS_A,
      zoneUntil: NOW_UNTIL,
      membershipRole: "owner",
      membershipStatus: "revoked",
    });
    const body = await (await handleZonesReserve(req("centro-storico", WS_A), db.factory)).json();
    expect(body.ok).toBe(true);
    expect(body.already_mine).toBe(true);
    expect(db.state.memberships.get(`${WS_A}:${USER_A}`)?.status).toBe("active");
    expect(db.state.memberships.size).toBe(1);
    expect(body.data.trial_until).toBe(NOW_UNTIL);
    expect(db.state.zoneUntil).toBe(NOW_UNTIL);
  });

  it("membership incompatibile nel retry: fallimento controllato, nessuna mutazione parziale", async () => {
    const db = makeDb({ zoneOwner: WS_A, zoneUntil: NOW_UNTIL, membershipRole: "viewer" });
    const res = await handleZonesReserve(req("centro-storico", WS_A), db.factory);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("membership_incompatibile");
    expect(db.state.memberships.get(`${WS_A}:${USER_A}`)).toEqual({ role: "viewer", status: "active" });
    expect(db.state.zoneUntil).toBe(NOW_UNTIL);
    expect(db.state.zoneOwner).toBe(WS_A);
  });

  it("utente già owner attivo di un'altra agenzia: nessuna agenzia/membership creata", async () => {
    const db = makeDb({ otherAgencyMembership: true });
    const res = await handleZonesReserve(req("centro-storico", WS_A), db.factory);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("membership_incompatibile");
    expect(db.state.agencies.has(WS_A)).toBe(false);
    expect(db.state.memberships.has(`${WS_A}:${USER_A}`)).toBe(false);
    expect(db.state.zoneOwner).toBeNull();
  });
});

describe("4A — micro-correzione: nessun codice tecnico mostrabile all'utente", () => {
  const TECH = /membership_incompatibile|parametri_non_validi|reserve_padova|agency_memberships|agencies|service[_ ]role|supabase|P0001|relation|pg_|stack/i;

  it("errore membership: message pubblico neutro, codice solo in error.code", async () => {
    const db = staticDb({ data: { ok: false, error: "membership_incompatibile" }, error: null });
    const body = await (await handleZonesReserve(req("centro-storico"), db.factory)).json();
    expect(body.error.code).toBe("membership_incompatibile");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message).not.toMatch(TECH);
    expect(body.message).toBeUndefined();
  });

  it("parametri non validi: messaggio pubblico privo del codice interno", async () => {
    const db = staticDb({ data: { ok: false, error: "parametri_non_validi" }, error: null });
    const body = await (await handleZonesReserve(req("centro-storico"), db.factory)).json();
    expect(body.error.code).toBe("parametri_non_validi");
    expect(body.error.message).not.toMatch(TECH);
  });

  it("eccezione PostgreSQL: nessun dettaglio tecnico nella risposta", async () => {
    const db = staticDb({
      data: null,
      error: { message: 'P0001 relation "agency_memberships" does not exist' },
    });
    const body = await (await handleZonesReserve(req("centro-storico"), db.factory)).json();
    expect(JSON.stringify(body)).not.toMatch(TECH);
  });

  it("tutti i codici applicativi hanno un messaggio pubblico distinto dal codice", async () => {
    for (const code of [
      "zona_in_trial",
      "zona_occupata",
      "agency_ha_gia_zona",
      "zona_non_trovata",
      "pilot_zone_locked",
    ]) {
      const db = staticDb({ data: { ok: false, error: code }, error: null });
      const body = await (await handleZonesReserve(req("centro-storico"), db.factory)).json();
      expect(body.error.code).toBe(code);
      expect(body.error.message).not.toContain(code);
      expect(body.error.message.length).toBeGreaterThan(5);
    }
  });

  it("header non validi e metodo errato: messaggi neutri", async () => {
    const bad = new Request("http://local/civiko-zones-reserve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-job-secret": SECRET,
        "x-workspace-id": "not-a-uuid",
        "x-user-id": USER_A,
      },
      body: JSON.stringify({ slug: "centro-storico" }),
    });
    const body = await (await handleZonesReserve(bad, staticDb({ data: null, error: null }).factory)).json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("richiesta_non_valida");
    expect(body.error.message).not.toMatch(/x-workspace-id|uuid|header/i);
  });
});


describe("4A — fail-closed sul payload RPC", () => {
  const cases: Array<[string, unknown]> = [
    ["payload nullo", null],
    ["payload senza ok", { zona: "centro-storico" }],
    ["ok non booleano", { ok: "true" }],
    ["ok numerico", { ok: 1 }],
    ["stringa", "already reserved"],
  ];
  for (const [label, data] of cases) {
    it(`${label} → risposta fallita, mai successo implicito`, async () => {
      const db = staticDb({ data, error: null });
      const res = await handleZonesReserve(req("centro-storico"), db.factory);
      expect(res.status).toBe(500);
      expect((await res.json()).ok).toBe(false);
    });
  }

  it("eccezione tecnica → errore neutro senza dettagli interni", async () => {
    const db = staticDb({ data: null, error: { message: 'relation "agencies" does not exist' } });
    const res = await handleZonesReserve(req("centro-storico"), db.factory);
    const raw = JSON.stringify(await res.json());
    expect(res.status).toBe(500);
    expect(raw).not.toMatch(/agencies|relation|reserve_padova|sql/i);
  });

  it("errore applicativo sconosciuto → codice neutro", async () => {
    const db = staticDb({ data: { ok: false, error: "P0001: deadlock detected" }, error: null });
    const res = await handleZonesReserve(req("centro-storico"), db.factory);
    expect((await res.json()).error.code).toBe("errore");
  });
});

describe("4A — contratto Edge", () => {
  it("l'Edge non crea più separatamente agenzia e membership", () => {
    expect(EDGE_SRC).not.toMatch(/from\("agencies"\)/);
    expect(EDGE_SRC).not.toMatch(/from\("agency_memberships"\)/);
  });
  it("l'Edge chiama esclusivamente la nuova RPC atomica", () => {
    expect(EDGE_SRC).toMatch(/reserve_padova_pilot_zone_atomic/);
    expect(EDGE_SRC).not.toMatch(/rpc\("reserve_commercial_zone"/);
  });
  it("l'Edge non accetta agency/workspace/user/email dal body", () => {
    expect(EDGE_SRC).not.toMatch(/body\.(agency|workspace|user|email)/);
  });
  it("il gate anticipato solo centro-storico resta presente", () => {
    expect(EDGE_SRC).toMatch(/isPadovaPilotAllowedZoneSlug/);
    expect(EDGE_SRC).toMatch(/pilot_zone_locked/);
  });
});

describe("4A — contratto territoriale invariato", () => {
  it("esattamente 8 zone ufficiali", () => {
    expect(CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug).sort()).toEqual([...OFFICIAL].sort());
  });
  it("Stazione → centro-storico, Fiera → est-brenta", () => {
    expect(commercialZoneForQuartiere("Stazione")).toBe("centro-storico");
    expect(commercialZoneForQuartiere("Fiera")).toBe("est-brenta");
  });
  it("stringhe miste Stazione/Fiera → null", () => {
    for (const k of [...PADOVA_PILOT_AMBIGUOUS_STAZIONE_FIERA_KEYS, "Stazione / Fiera"]) {
      expect(commercialZoneForQuartiere(k)).toBeNull();
    }
  });
});
