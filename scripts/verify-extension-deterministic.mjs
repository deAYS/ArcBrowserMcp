/**
 * Deterministic-build verification.
 *
 * Runs extension/build.mjs twice with no source changes and asserts:
 * - buildId #1 == buildId #2
 * - background.js SHA-256 #1 == SHA-256 #2
 *
 * Exit 0 on match; exit 1 with evidence otherwise.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runBuild() {
  execFileSync(process.execPath, ["extension/build.mjs"], { cwd: repoRoot, stdio: "inherit" });
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, "extension", "dist", "manifest.json"), "utf8"),
  );
  const background = readFileSync(path.join(repoRoot, "extension", "dist", "background.js"));
  return {
    // The build script logs buildId itself; recompute here for the gate.
    backgroundSha256: createHash("sha256").update(background).digest("hex"),
    backgroundBytes: background.length,
    manifestVersion: manifest.version,
  };
}

const first = runBuild();
const { computeExtensionBuildId } = await import("../extension/fingerprint.mjs");
const buildIdFirst = computeExtensionBuildId(repoRoot);
const second = runBuild();
const buildIdSecond = computeExtensionBuildId(repoRoot);

const evidence = {
  buildIdFirst,
  buildIdSecond,
  repeatedBuildIdsEqual: buildIdFirst === buildIdSecond,
  firstBuildSha256: first.backgroundSha256,
  secondBuildSha256: second.backgroundSha256,
  repeatedBundleHashesEqual: first.backgroundSha256 === second.backgroundSha256,
  backgroundBytes: second.backgroundBytes,
};

console.log(JSON.stringify({ evidence }, null, 2));
if (!evidence.repeatedBuildIdsEqual || !evidence.repeatedBundleHashesEqual) {
  process.exit(1);
}
