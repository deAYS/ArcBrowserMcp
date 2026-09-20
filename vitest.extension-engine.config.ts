import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/extension-engine/**/*.test.ts"],
    globalSetup: ["./tests/globalSetup.ts"],
    testTimeout: 480_000,
    hookTimeout: 60_000,
  },
});
