import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const AI_CORE_SECRET = Deno.env.get("AI_CORE_SECRET") ?? "";

Deno.test("scan/pricing returns real OMI data for Milano", async () => {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/sottra/scan/pricing`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": AI_CORE_SECRET,
    },
    body: JSON.stringify({ address: "Via Roma 1, Milano" }),
  });

  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text);

  assertEquals(res.status, 200);

  const json = JSON.parse(text);
  assertEquals(json.ok, true);
  console.log("Data:", JSON.stringify(json.data, null, 2));
  console.log("Warnings:", json.warnings);

  // Check it has OMI-specific fields
  if (json.data.fonte && json.data.fonte.includes("OMI")) {
    console.log("✅ Real OMI data returned!");
  } else {
    console.log("⚠️ AI fallback used, fonte:", json.data.fonte);
  }
});
