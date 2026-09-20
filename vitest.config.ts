import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/arc-integration/**", "tests/extension-engine/**", "tests/tabs/**", "tests/navigation/**", "tests/snapshot/**", "tests/interactions/**", "tests/page-tools/**", "tests/observability/**", "tests/live/**"],
    globalSetup: ["./tests/globalSetup.ts"],
  },
});
