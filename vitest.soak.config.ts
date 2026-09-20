import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/soak.e2e.test.ts"],
    globalSetup: ["./tests/globalSetup.ts"],
    testTimeout: 1_200_000,
    hookTimeout: 120_000,
  },
});
