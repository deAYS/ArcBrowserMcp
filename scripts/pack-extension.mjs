/**
 * Release packaging: fresh deterministic build, then a store-uploadable
 * zip plus a sha256 sidecar in release/.
 *
 * No .crx: signing needs the extension private key, which must never be
 * committed (enforced by tests/release/toolsetSecurity.test.ts). Upload
 * the zip to the Chrome Web Store dashboard (or sideload it); the store
 * signs on publish.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "extension", "dist");
const releaseDir = path.join(repoRoot, "release");

// Fresh build so the zip always matches current sources (and the pinned key).
execFileSync(process.execPath, ["extension/build.mjs"], { cwd: repoRoot, stdio: "inherit" });
const { computeExtensionBuildId } = await import("../extension/fingerprint.mjs");
const buildId = computeExtensionBuildId(repoRoot);

// Stage a release copy under the store-facing name; sources stay dev-named.
const manifest = JSON.parse(readFileSync(path.join(distDir, "manifest.json"), "utf8"));
const stageDir = path.join(releaseDir, "stage");
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
cpSync(distDir, stageDir, { recursive: true });
const stagedManifest = { ...manifest, name: manifest.name.replace(/ - Development$/, "") };
writeFileSync(path.join(stageDir, "manifest.json"), `${JSON.stringify(stagedManifest, null, 2)}\n`);

// Zip the stage contents (manifest.json at the zip root) with platform
// tooling, so this adds no new dependencies.
const zipName = `arc-mcp-bridge-${manifest.version}-${buildId.slice(0, 8)}.zip`;
const zipPath = path.join(releaseDir, zipName);
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Compress-Archive -Path ${psQuote(`${stageDir}\\*`)} -DestinationPath ${psQuote(zipPath)} -Force`,
  ],
  { stdio: "inherit" },
);
rmSync(stageDir, { recursive: true, force: true });

const sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`);
console.log(`release ready: ${zipPath}\nsha256: ${sha256}`);
