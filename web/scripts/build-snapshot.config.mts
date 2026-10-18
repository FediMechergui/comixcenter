/** Runs scripts/build-snapshot.ts with the real network and the accounts from .env.local. */
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "..") } },
  test: {
    // Node, not happy-dom: the browser env enforces CORS, which CapacitorHttp on the phone does not.
    environment: "node",
    include: ["scripts/build-snapshot.ts"],
    // No test-setup here on purpose: the builder needs real credentials and real HTTP.
    setupFiles: ["fake-indexeddb/auto"],
    testTimeout: 6 * 60 * 60_000,
    hookTimeout: 60_000,
    // One long-running fork: the default pool crashed allocating workers on Windows.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
