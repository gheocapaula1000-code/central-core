// Test statici: completezza fail-closed dell'aggregato off-market pubblico.
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SRC = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("nessuna fonte letta con il vecchio cap silenzioso di 500", () => {
  assert(!SRC.includes(".limit(500)"), "il cap 500 silenzioso deve sparire");
  assertStringIncludes(SRC, "SOURCE_CAP = 5000");
  assertStringIncludes(SRC, "fetchAllRows");
});

Deno.test("truncation su una fonte => snapshot non probante", () => {
  assertStringIncludes(SRC, 'error: "SOURCE_TRUNCATED"');
  assertStringIncludes(SRC, "if (truncatedSources.length > 0)");
  assertStringIncludes(SRC, "snapshot_complete: false");
});

Deno.test("la RPC distress senza count è fail-closed al cap", () => {
  assertStringIncludes(SRC, "p_limit: SOURCE_CAP");
  assertStringIncludes(SRC, 'if (rpcRows.length >= SOURCE_CAP) truncatedSources.push("distress")');
});

Deno.test("source_counts e source_caps sempre esposti", () => {
  assertStringIncludes(SRC, "source_counts: sourceCounts");
  assertStringIncludes(SRC, "source_caps: sourceCaps");
});

Deno.test("risposta finale paginata con total autorevole", () => {
  assertStringIncludes(SRC, "const total = outItems.length;");
  assertStringIncludes(SRC, "outItems.slice(pageOffset, pageOffset + pageLimit)");
  assertStringIncludes(SRC, "has_more: pageOffset + pageItems.length < total");
});

Deno.test("privacy, aste e perimetro invariati", () => {
  assertStringIncludes(SRC, '.eq("privacy_safe", true)');
  assertStringIncludes(SRC, '.eq("pii_redacted", true)');
  assertStringIncludes(SRC, "isAuctionRecord(r)");
  assertStringIncludes(SRC, "isValidCommercialZoneSlug");
});
