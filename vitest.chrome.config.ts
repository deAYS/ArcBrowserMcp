import { defineConfig } from "vitest/config";

// Live integration against the real dedicated Google Chrome instance.
process.env["ARC_MCP_TEST_BROWSER"] = "chrome";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/browser-integration/**/*.test.ts"],
    globalSetup: ["./tests/globalSetup.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
