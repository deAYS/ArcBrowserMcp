/**
 * Dev-mode install: builds the server + extension, registers the native
 * host, then prints the manual "Load unpacked" step (Chromium requires a
 * human click at arc://extensions; that part cannot be scripted).
 */
import { execFileSync, execSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Reuse the tested package scripts instead of reimplementing their steps.
execSync("pnpm build", { cwd: repoRoot, stdio: "inherit" });
execSync("pnpm build:extension", { cwd: repoRoot, stdio: "inherit" });
execFileSync(process.execPath, ["dist/bridge/cli.js", "install"], {
  cwd: repoRoot,
  stdio: "inherit",
});
execFileSync(process.execPath, ["dist/bridge/cli.js", "check"], {
  cwd: repoRoot,
  stdio: "inherit",
});

const idJson = execFileSync(process.execPath, ["dist/bridge/cli.js", "extension-id"], {
  cwd: repoRoot,
  encoding: "utf8",
});
const { extensionId } = JSON.parse(idJson);

console.log(`
Dev install complete. Finish in Arc (requires a human click):
  1. Open arc://extensions in Arc.
  2. Enable Developer mode.
  3. Load unpacked -> ${path.join(repoRoot, "extension", "dist")}
Expected extension ID: ${extensionId}`);
