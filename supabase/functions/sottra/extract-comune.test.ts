import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Inline the function to test it directly
function extractComune(address: string): string {
  const cleaned = address.replace(/\b\d{5}\b/g, "").trim();
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && /^ital/i.test(parts[parts.length - 1])) {
    parts.pop();
  }
  const last = parts[parts.length - 1] ?? "";
  const withoutProv = last.replace(/\s+[A-Z]{2}$/, "").trim();
  return withoutProv.toUpperCase();
}

Deno.test("Google Geocoding format", () => {
  assertEquals(extractComune("Via Giovanni Fortin Monsignor, 31, 35128 Padova PD, Italia"), "PADOVA");
});

Deno.test("Simple format", () => {
  assertEquals(extractComune("Via Guido Reni 8, 35133 Padova"), "PADOVA");
});

Deno.test("Roma format", () => {
  assertEquals(extractComune("Via del Corso 100, 00186 Roma RM, Italia"), "ROMA");
});

Deno.test("Without Italia", () => {
  assertEquals(extractComune("Via Toledo 10, 80132 Napoli NA"), "NAPOLI");
});
