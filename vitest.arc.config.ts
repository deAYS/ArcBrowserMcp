import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/arc-integration/**/*.test.ts"],
    globalSetup: ["./tests/globalSetup.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
