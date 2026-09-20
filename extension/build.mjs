/**
 * Extension build: esbuild bundles the MV3 service worker and diagnostic
 * page (MV3 service workers need browser-loadable output, which plain tsc
 * cannot produce from multi-file modules), then static files are copied so
 * extension/dist/ loads directly via arc://extensions "Load unpacked".
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { computeExtensionBuildId } from "./fingerprint.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");

await mkdir(path.join(dist, "diagnostic"), { recursive: true });

// Deterministic content-derived build identity: SHA-256 over sorted
// relative path + file bytes of every extension input (never a timestamp),
// so source-identical builds produce an identical buildId and bundle hash.
const repoRoot = path.dirname(root);
const BUILD_ID = computeExtensionBuildId(repoRoot);

await build({
  entryPoints: [path.join(root, "src", "background.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2021",
  outfile: path.join(dist, "background.js"),
  logLevel: "info",
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
});

await build({
  entryPoints: [path.join(root, "diagnostic", "diagnostic.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2021",
  outfile: path.join(dist, "diagnostic", "diagnostic.js"),
  logLevel: "info",
});

await copyFile(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
// Inject the stable development identity: the committed public key from
// identity.json becomes the manifest "key", pinning the unpacked extension
// ID across rebuilds and checkout paths. The private key is never here.
const identity = JSON.parse(await readFile(path.join(root, "identity.json"), "utf8"));
if (typeof identity.publicKey !== "string" || identity.publicKey.trim() === "") {
  throw new Error("extension/identity.json must contain a non-empty publicKey");
}
const distManifestPath = path.join(dist, "manifest.json");
const distManifest = JSON.parse(await readFile(distManifestPath, "utf8"));
distManifest.key = identity.publicKey.trim();
await writeFile(distManifestPath, JSON.stringify(distManifest, null, 2) + "\n");
await copyFile(
  path.join(root, "diagnostic", "diagnostic.html"),
  path.join(dist, "diagnostic", "diagnostic.html"),
);

console.log(`extension build complete: extension/dist/ buildId=${BUILD_ID}`);

// Self-evidence for the determinism gate: SHA-256 of the emitted bundle.
const backgroundBytes = await readFile(path.join(dist, "background.js"));
console.log(`background sha256=${createHash("sha256").update(backgroundBytes).digest("hex")}`);
