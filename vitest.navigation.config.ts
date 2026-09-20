import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/navigation/**/*.test.ts"],
    globalSetup: ["./tests/globalSetup.ts"],
    testTimeout: 480_000,
    hookTimeout: 60_000,
  },
});
