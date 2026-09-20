/**
 * Deterministic extension build identity.
 *
 * Earlier builds embedded a wall-clock timestamp, so source-identical builds
 * produced different buildIds and different background.js hashes. This module
 * derives the buildId as a SHA-256 fingerprint over deterministic build
 * inputs instead: every file under extension/ (excluding the dist/ output),
 * plus the extension-consumed shared sources bundled into background.js,
 * plus the repo-level package/lock metadata that selects the bundler.
 *
 * Extension-consumed shared sources: the background bundle imports
 * src/browser/navigationPolicy, snapshotSemantics, interactionPolicy,
 * pageToolsPolicy, observability/*, security/Redaction, and
 * bridge/frameLimits. Changing any of them MUST change the buildId, so they
 * are explicit fingerprint inputs (not merely transitively discovered).
 *
 * No Date.now, no timestamps, no randomness: repeated builds with no input
 * change produce an identical buildId and an identical bundle hash.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function walkExtensionFiles(extensionDir) {
  const files = [];
  const visit = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // The build output itself is never an input.
        if (dir === extensionDir && entry.name === "dist") {
          continue;
        }
        visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  visit(extensionDir);
  return files;
}

/**
 * Sorted POSIX relative paths of every deterministic build input, e.g.
 * extension/src/background.ts plus package.json / pnpm-lock.yaml (the
 * bundler version selects the output bytes, so it is an input too), plus
 * every shared src/ module bundled into background.js.
 */
export function listExtensionFingerprintInputs(repoRoot) {
  const extensionDir = path.join(repoRoot, "extension");
  const inputs = walkExtensionFiles(extensionDir).map((full) =>
    toPosix(path.relative(repoRoot, full)),
  );
  inputs.push("package.json", "pnpm-lock.yaml");
  // Shared sources bundled into background.js (esbuild follows these
  // imports; the fingerprint names them explicitly so the dependency is
  // structural and asserted by tests rather than inferred).
  for (const shared of listExtensionConsumedSharedSources(repoRoot)) {
    inputs.push(shared);
  }
  return [...new Set(inputs)].sort();
}

/**
 * Shared src/ modules consumed by the extension bundle (relative POSIX
 * paths). background.js imports these via ../../src/... specifiers; any
 * change here changes background.js bytes and therefore MUST change buildId.
 */
export function listExtensionConsumedSharedSources(repoRoot) {
  const shared = [
    "src/browser/navigationPolicy.ts",
    "src/browser/snapshotSemantics.ts",
    "src/browser/interactionPolicy.ts",
    "src/browser/pageToolsPolicy.ts",
    "src/observability/observabilityPolicy.ts",
    "src/observability/ConsoleMonitor.ts",
    "src/observability/NetworkMonitor.ts",
    "src/security/Redaction.ts",
    "src/bridge/frameLimits.ts",
  ];
  // Only list files that actually exist (defensive: never hash a missing
  // path; computeExtensionBuildId reads every listed input).
  return shared.filter((rel) => existsSync(path.join(repoRoot, rel)));
}

/** 64-hex SHA-256 over (relative path + file bytes) for every input. */
export function computeExtensionBuildId(repoRoot) {
  const hash = createHash("sha256");
  for (const rel of listExtensionFingerprintInputs(repoRoot)) {
    const bytes = readFileSync(path.join(repoRoot, rel));
    hash.update(rel, "utf-8");
    hash.update("\0", "utf-8");
    hash.update(bytes);
    hash.update("\0", "utf-8");
  }
  return hash.digest("hex");
}
