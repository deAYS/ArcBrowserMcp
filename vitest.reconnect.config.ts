import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/reconnect.e2e.test.ts"],
    globalSetup: ["./tests/globalSetup.ts"],
    testTimeout: 480_000,
    hookTimeout: 120_000,
  },
});
