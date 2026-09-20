import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/reliability/**/*.test.ts", "tests/release/**/*.test.ts"],
    globalSetup: ["./tests/globalSetup.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
