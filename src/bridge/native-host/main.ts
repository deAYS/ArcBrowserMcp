import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extensionOrigin, loadExtensionIdentity } from "../extensionIdentity.js";
import { defaultSessionDir, BRIDGE_SESSION_FILE_NAME } from "../session.js";
import { fileSessionLoader, runHost } from "./host.js";

/**
 * Native host process entry (launched by the browser via the generated .cmd).
 * stdout carries Native Messaging frames only; every diagnostic goes to
 * stderr. Resolves paths from this checkout: repo root is three levels
 * above dist/bridge/native-host/.
 */
function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

const repoRoot = repoRootFromHere();
const expectedOrigin = extensionOrigin(loadExtensionIdentity(repoRoot).extensionId);
const sessionPath = `${defaultSessionDir()}\\${BRIDGE_SESSION_FILE_NAME}`;

runHost({
  argv: process.argv.slice(2),
  expectedOrigin,
  loadSession: fileSessionLoader(sessionPath),
  journalPath: path.join(path.dirname(sessionPath), "..", "native-host", "launches.log"),
  stdin: process.stdin,
  stdout: process.stdout,
  log: (message: string) => {
    process.stderr.write(`arc-mcp-native-host: ${message}\n`);
  },
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`arc-mcp-native-host fatal: ${String(error)}\n`);
    process.exitCode = 6;
  },
);
