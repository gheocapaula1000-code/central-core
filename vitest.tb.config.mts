import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve("/dev-server/src") } },
  test: { root: "/dev-server", environment: "node", setupFiles: [], include: ["src/test/trovabandi-*.test.ts"] },
});
