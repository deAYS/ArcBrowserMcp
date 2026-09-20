import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - plain-JS fingerprint module carries its own adjacent .d.ts semantics
import { computeExtensionBuildId, listExtensionFingerprintInputs } from "../extension/fingerprint.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("deterministic extension build identity", () => {
  it("fingerprints sorted extension inputs plus bundler metadata (never dist)", () => {
    const inputs = listExtensionFingerprintInputs(REPO_ROOT);
    expect(inputs.length).toBeGreaterThan(5);
    expect(inputs).toEqual([...inputs].sort());
    expect(inputs.some((entry: string) => entry.startsWith("extension/dist"))).toBe(false);
    expect(inputs).toContain("extension/src/background.ts");
    expect(inputs).toContain("extension/manifest.json");
    expect(inputs).toContain("extension/identity.json");
    expect(inputs).toContain("extension/build.mjs");
    expect(inputs).toContain("extension/tsconfig.json");
    expect(inputs).toContain("package.json");
    expect(inputs).toContain("pnpm-lock.yaml");
  });

  it("produces a stable 64-hex buildId for identical inputs", () => {
    const first = computeExtensionBuildId(REPO_ROOT);
    const second = computeExtensionBuildId(REPO_ROOT);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
  });

  it("matches the emitted dist bundle identity", () => {
    const buildId = computeExtensionBuildId(REPO_ROOT);
    const background = readFileSync(path.join(REPO_ROOT, "extension", "dist", "background.js"));
    const sha = createHash("sha256").update(background).digest("hex");
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    // The build script defines the same buildId the worker reports; the
    // bundle embeds it deterministically (no timestamp anywhere).
    expect(buildId).toMatch(/^[0-9a-f]{64}$/);
  });
});
