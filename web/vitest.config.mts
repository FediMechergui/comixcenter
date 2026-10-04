import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: {
    environment: "happy-dom",
    include: ["lib/**/*.test.ts"],
    setupFiles: ["lib/engine/test-setup.ts"],
    testTimeout: 20000,
  },
});
