import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const shared = readFileSync("supabase/functions/_shared/billing.ts", "utf8");
const handler = readFileSync("supabase/functions/civiko-billing/index.ts", "utf8");

describe("Civiko Stripe is Test-only", () => {
  it("accepts only Stripe test or restricted-test keys", () => {
    expect(shared).toContain('value.startsWith("sk_test_")');
    expect(shared).toContain('value.startsWith("rk_test_")');
    expect(shared).toContain("liveModeBlocked");
    expect(shared).not.toMatch(/price_1TSC[A-Za-z0-9]+/);
  });

  it("blocks every direct Stripe write when a Live key is configured", () => {
    expect(handler).toContain("isStripeTestSecret(secretKey)");
    expect(handler.match(/LIVE_MODE_BLOCKED/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  it("requires livemode=false on provider responses and webhook events", () => {
    expect(handler).toContain("r.data.livemode !== false");
    expect(handler).toContain("r.data?.livemode !== false");
    expect(handler).toContain("event.livemode !== false");
    expect(handler).toContain('billingMode: readStripeEnv().testMode ? "test" : "disabled"');
  });
});
