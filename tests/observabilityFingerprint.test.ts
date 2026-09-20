import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - plain-JS fingerprint module carries its own adjacent .d.ts semantics
import { computeExtensionBuildId, listExtensionConsumedSharedSources, listExtensionFingerprintInputs } from "../extension/fingerprint.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("fingerprint covers extension-consumed shared sources", () => {
  it("lists every shared observability/redaction/policy source", () => {
    const inputs = listExtensionFingerprintInputs(REPO_ROOT);
    for (const shared of [
      "src/observability/observabilityPolicy.ts",
      "src/observability/ConsoleMonitor.ts",
      "src/observability/NetworkMonitor.ts",
      "src/security/Redaction.ts",
      "src/browser/navigationPolicy.ts",
      "src/browser/snapshotSemantics.ts",
      "src/browser/interactionPolicy.ts",
      "src/browser/pageToolsPolicy.ts",
      "src/bridge/frameLimits.ts",
    ]) {
      expect(inputs, `fingerprint must include ${shared}`).toContain(shared);
    }
    expect(listExtensionConsumedSharedSources(REPO_ROOT)).toEqual(
      expect.arrayContaining([
        "src/security/Redaction.ts",
        "src/observability/ConsoleMonitor.ts",
        "src/observability/NetworkMonitor.ts",
      ]),
    );
  });

  it("changing an extension-consumed shared source changes buildId", () => {
    const baseline = computeExtensionBuildId(REPO_ROOT);
    const target = path.join(REPO_ROOT, "src/security/Redaction.ts");
    const original = readFileSync(target);
    // Same-length single-byte flip: proves the hash covers file BYTES (not
    // just paths/sizes) without touching the working tree.
    const mutated = Buffer.from(original);
    mutated[mutated.length - 1] = mutated[mutated.length - 1] === 0x41 ? 0x42 : 0x41;
    const hash = createHash("sha256");
    for (const rel of listExtensionFingerprintInputs(REPO_ROOT)) {
      const bytes = rel === "src/security/Redaction.ts" ? mutated : readFileSync(path.join(REPO_ROOT, rel));
      hash.update(rel, "utf-8");
      hash.update("\0", "utf-8");
      hash.update(bytes);
      hash.update("\0", "utf-8");
    }
    expect(hash.digest("hex")).not.toBe(baseline);
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
  });
});
