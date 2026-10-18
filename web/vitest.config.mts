import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": import.meta.dirname } },
  test: {
    environment: "happy-dom",
    include: ["lib/**/*.test.ts"],
    setupFiles: ["lib/engine/test-setup.ts"],
    testTimeout: 20000,
  },
});
