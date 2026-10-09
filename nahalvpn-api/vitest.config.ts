import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The first test in each file pays for loading argon2 + Fastify while other files do the same in parallel.
    testTimeout: 30_000,
  },
});
