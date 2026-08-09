import { describe, expect, it } from "vitest";
import {
  CANDIDATE_FRESH_HOURS,
  CANDIDATE_NO_CONTENT_COOLDOWN_HOURS,
  canonicalCandidateUrl,
  containsSensitiveData,
  dedupeCandidates,
  freshCandidates,
  isCandidateQuarantined,
  rotateCandidates,
  sanitizeProviderQuery,
  shouldSkipPaidSearch,
} from "../../supabase/functions/trovabandi-engine/candidates.ts";
import { isRealSuccessfulScan } from "../../supabase/functions/trovabandi-engine/hardening.ts";

const NOW = Date.parse("2026-08-07T12:00:00.000Z");
const hoursAgo = (hours: number) =>
  new Date(NOW - hours * 3_600_000).toISOString();

describe("trovabandi candidate cache — canonicalizzazione e dedup", () => {
  it("normalizza host, tracking e slash finale", () => {
    expect(
      canonicalCandidateUrl("https://WWW.Regione.Veneto.it/bandi/?utm_source=x"),
    ).toBe("https://regione.veneto.it/bandi");
    expect(canonicalCandidateUrl("https://a.it/x#frag")).toBe("https://a.it/x");
    expect(canonicalCandidateUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalCandidateUrl("https://user:pw@a.it/x")).toBeNull();
  });

  it("deduplica lo stesso URL canonico unendo i provider", () => {
    const pool = dedupeCandidates([
      { url: "https://a.it/b/", provider: "firecrawl" },
      { url: "https://www.a.it/b?utm_medium=m", provider: "perplexity" },
    ]);
    expect(pool).toHaveLength(1);
    expect(pool[0].provider).toContain("firecrawl");
    expect(pool[0].provider).toContain("perplexity");
  });

  it("considera fresco solo entro la finestra di cache", () => {
    const fresh = freshCandidates(
      [
        { url: "https://a.it/1", last_seen_at: hoursAgo(1) },
        {
          url: "https://a.it/2",
          last_seen_at: hoursAgo(CANDIDATE_FRESH_HOURS + 5),
        },
        { url: "https://a.it/3" },
      ],
      NOW,
    );
    expect(fresh.map((c) => c.url)).toEqual(["https://a.it/1"]);
  });
});

describe("trovabandi candidate cache — rotazione deterministica", () => {
  it("privilegia i mai tentati e poi i meno recentemente tentati", () => {
    const rotated = rotateCandidates(
      [
        {
          url: "https://a.it/hit1",
          last_attempted_at: hoursAgo(1),
          attempt_count: 9,
        },
        {
          url: "https://a.it/hit2",
          last_attempted_at: hoursAgo(2),
          attempt_count: 7,
        },
        { url: "https://a.it/deep1" },
        {
          url: "https://a.it/old",
          last_attempted_at: hoursAgo(300),
          attempt_count: 1,
        },
      ],
      3,
    );
    expect(rotated.map((c) => c.url)).toEqual([
      "https://a.it/deep1",
      "https://a.it/old",
      "https://a.it/hit2",
    ]);
  });

  it("rispetta rigorosamente il limite max_pages ed è stabile", () => {
    const pool = [
      { url: "https://a.it/b" },
      { url: "https://a.it/a" },
      { url: "https://a.it/c" },
    ];
    expect(rotateCandidates(pool, 2).map((c) => c.url)).toEqual([
      "https://a.it/a",
      "https://a.it/b",
    ]);
    expect(rotateCandidates(pool, 2)).toEqual(rotateCandidates(pool, 2));
  });

  it("salta la ricerca a pagamento solo con pool fresco sufficiente", () => {
    expect(shouldSkipPaidSearch(3, 3)).toBe(true);
    expect(shouldSkipPaidSearch(2, 3)).toBe(false);
    expect(shouldSkipPaidSearch(0, 1)).toBe(false);
  });
});

describe("trovabandi candidate cache — quarantena NO_CONTENT", () => {
  it("esclude dal fresh pool e dalla rotazione un URL avvelenato", () => {
    const poisoned = {
      url: "https://padovanet.it/albo/morto",
      last_seen_at: hoursAgo(4),
      last_attempted_at: hoursAgo(1),
      attempt_count: 2,
      content_hash: null,
    };
    expect(isCandidateQuarantined(poisoned, NOW)).toBe(true);
    expect(freshCandidates([poisoned], NOW)).toEqual([]);
    expect(rotateCandidates([poisoned], 2, NOW)).toEqual([]);
    expect(shouldSkipPaidSearch(freshCandidates([poisoned], NOW).length, 1)).toBe(false);
  });

  it("riabilita il candidato solo con una nuova hit successiva al fallimento", () => {
    const refreshed = {
      url: "https://regione.vda.it/catalogo",
      last_seen_at: hoursAgo(1),
      last_attempted_at: hoursAgo(2),
      attempt_count: 4,
      content_hash: null,
    };
    expect(isCandidateQuarantined(refreshed, NOW)).toBe(false);
    expect(freshCandidates([refreshed], NOW)).toHaveLength(1);
  });

  it("riammette dopo il cooldown esplicito senza fingere una nuova hit", () => {
    const cooledDown = {
      url: "https://mimit.gov.it/catalogo",
      last_seen_at: hoursAgo(CANDIDATE_NO_CONTENT_COOLDOWN_HOURS + 2),
      last_attempted_at: hoursAgo(CANDIDATE_NO_CONTENT_COOLDOWN_HOURS + 1),
      attempt_count: 3,
      content_hash: null,
    };
    expect(isCandidateQuarantined(cooledDown, NOW)).toBe(false);
    expect(rotateCandidates([cooledDown], 1, NOW)).toHaveLength(1);
  });

  it("non mette in quarantena contenuto già valido o un singolo NO_CONTENT", () => {
    expect(isCandidateQuarantined({
      url: "https://a.it/valido",
      last_attempted_at: hoursAgo(1),
      attempt_count: 9,
      content_hash: "sha256",
    }, NOW)).toBe(false);
    expect(isCandidateQuarantined({
      url: "https://a.it/primo-tentativo",
      last_attempted_at: hoursAgo(1),
      attempt_count: 1,
      content_hash: null,
    }, NOW)).toBe(false);
  });
});

describe("trovabandi provider privacy", () => {
  it("non invia mai email/PEC/telefono/P.IVA ai provider", () => {
    const query = sanitizeProviderQuery(
      "bandi Veneto PEC: studio@pec.it telefono +39 049 1234567 P.IVA 01234567890 impresa femminile",
    );
    expect(query).not.toMatch(/@/);
    expect(query).not.toMatch(/01234567890/);
    expect(query).not.toMatch(/1234567/);
    expect(query).toContain("bandi Veneto");
    expect(containsSensitiveData(query)).toBe(false);
  });

  it("conserva i termini territoriali non sensibili", () => {
    expect(sanitizeProviderQuery("contributi Padova GAL Patavino 2026")).toBe(
      "contributi Padova GAL Patavino 2026",
    );
  });
});

describe("trovabandi fail-closed con cache", () => {
  it("uno scan servito dalla cache resta uno scan reale", () => {
    expect(
      isRealSuccessfulScan({
        source_id: "s1",
        provider_usage: {
          firecrawl_search_status: "SKIPPED_CACHE",
          perplexity_search_status: "SKIPPED_CACHE",
          pages_attempted: 3,
          pages_scraped: 3,
        },
      }),
    ).toBe(true);
  });

  it("un guasto provider non diventa uno scan reale", () => {
    expect(
      isRealSuccessfulScan({
        source_id: "s1",
        provider_usage: {
          firecrawl_search_status: "TIMEOUT",
          perplexity_search_status: "SKIPPED_CACHE",
          pages_attempted: 1,
          pages_scraped: 1,
        },
      }),
    ).toBe(false);
  });

  it("non genera candidati da URL non ufficiali o malformati", () => {
    expect(
      dedupeCandidates([{ url: "not-a-url" }, { url: "" }, { url: "ftp://a" }]),
    ).toEqual([]);
  });
});
