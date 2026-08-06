import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", include: ["src/test/trovabandi-gate-hardening.test.ts"] },
});
