import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { arcMcpStateDir, bridgePipeName, NATIVE_HOST_NAME } from "./constants.js";
import { extensionIdFromPublicKeyBase64, extensionOrigin, loadExtensionIdentity } from "./extensionIdentity.js";
import { hostInstallLayout, renderHostLauncher, renderHostManifest, writeHostFiles } from "./hostManifest.js";
import { installHostRegistration, queryHostRegistration, uninstallHostRegistration } from "./registry.js";
import { defaultSessionDir } from "./session.js";
import { McpPipeServer } from "./mcpPipeServer.js";

function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function distDirFromHere(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`bridge cli: ${message}\n`);
  process.exit(1);
  throw new Error("unreachable");
}

async function cmdExtensionId(repoRoot: string): Promise<void> {
  const identity = loadExtensionIdentity(repoRoot);
  printJson({
    extensionId: identity.extensionId,
    origin: extensionOrigin(identity.extensionId),
    method: "manifest-key RSA-2048-SPKI sha256 first-128-bits mapped to [a-p] (Chromium algorithm)",
  });
}

async function cmdInstall(repoRoot: string): Promise<void> {
  const identity = loadExtensionIdentity(repoRoot);
  const origin = extensionOrigin(identity.extensionId);
  const stateDir = arcMcpStateDir();
  const layout = hostInstallLayout(stateDir);
  const hostScript = path.join(distDirFromHere(), "native-host", "main.js");
  if (!existsSync(hostScript)) {
    fail(`native host entry missing; run pnpm build first (expected ${hostScript})`);
  }
  const manifest = renderHostManifest(layout.launcherPath, origin);
  const launcher = renderHostLauncher(process.execPath, hostScript);
  const written = await writeHostFiles(layout, manifest, launcher);
  await installHostRegistration(written.manifestPath);
  // Self-verify the derivation matches the committed public key independently.
  const recomputed = extensionIdFromPublicKeyBase64(identity.publicKeyBase64);
  if (recomputed !== identity.extensionId) {
    fail("internal extension ID mismatch");
  }
  printJson({
    installed: true,
    hostName: NATIVE_HOST_NAME,
    manifestPath: written.manifestPath,
    launcherPath: written.launcherPath,
    allowedOrigin: origin,
    extensionId: identity.extensionId,
  });
}

async function cmdUninstall(): Promise<void> {
  const stateDir = arcMcpStateDir();
  const layout = hostInstallLayout(stateDir);
  await uninstallHostRegistration();
  // Remove only generated host files; never sessions, profiles, or anything else.
  await rm(layout.manifestPath, { force: true });
  await rm(layout.launcherPath, { force: true });
  printJson({ uninstalled: true, hostName: NATIVE_HOST_NAME });
}

async function cmdCheck(repoRoot: string): Promise<void> {
  const identity = loadExtensionIdentity(repoRoot);
  const expectedOrigin = extensionOrigin(identity.extensionId);
  const stateDir = arcMcpStateDir();
  const layout = hostInstallLayout(stateDir);
  const manifestExists = existsSync(layout.manifestPath);
  const launcherExists = existsSync(layout.launcherPath);
  let manifestOrigin: string | null = null;
  let manifestPathValue: string | null = null;
  if (manifestExists) {
    try {
      const parsed = JSON.parse(await readFile(layout.manifestPath, "utf-8")) as {
        allowed_origins?: unknown;
        path?: unknown;
      };
      if (Array.isArray(parsed.allowed_origins) && typeof parsed.allowed_origins[0] === "string") {
        manifestOrigin = parsed.allowed_origins[0];
      }
      if (typeof parsed.path === "string") {
        manifestPathValue = parsed.path;
      }
    } catch {
      manifestOrigin = null;
    }
  }
  const registryPath = await queryHostRegistration();
  const healthy =
    manifestExists &&
    launcherExists &&
    manifestOrigin === expectedOrigin &&
    manifestPathValue === layout.launcherPath &&
    registryPath === layout.manifestPath;
  printJson({
    healthy,
    hostName: NATIVE_HOST_NAME,
    manifestPath: layout.manifestPath,
    manifestExists,
    launcherExists,
    extensionId: identity.extensionId,
    allowedOrigin: manifestOrigin,
    originMatches: manifestOrigin === expectedOrigin,
    registryPath,
    registryMatches: registryPath === layout.manifestPath,
  });
  if (!healthy) {
    process.exitCode = 1;
  }
}

async function cmdBridgePing(): Promise<void> {
  const pipeName = bridgePipeName(process.env["USERNAME"]);
  const server = new McpPipeServer({ pipeName, sessionDir: defaultSessionDir() });
  await server.start();
  const deadline = Date.now() + 120_000;
  while (server.relayState !== "connected" && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  if (server.relayState !== "connected") {
    await server.stop();
    fail("no authenticated relay connected within 120s (is the extension bridge running?)");
  }
  try {
    const { id, payload } = await server.requestDetailed("bridge.ping", {}, 15_000);
    printJson({ requestId: id, responseId: id, roundTrip: true, payload });
  } finally {
    await server.stop();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const repoRoot = repoRootFromHere();
  if (command === "extension-id") {
    await cmdExtensionId(repoRoot);
  } else if (command === "install") {
    await cmdInstall(repoRoot);
  } else if (command === "uninstall") {
    await cmdUninstall();
  } else if (command === "check") {
    await cmdCheck(repoRoot);
  } else if (command === "bridge-ping") {
    await cmdBridgePing();
  } else {
    process.stderr.write("usage: bridge-cli <extension-id|install|uninstall|check|bridge-ping>\n");
    process.exit(1);
  }
}

main().then(
  () => undefined,
  (error: unknown) => {
    process.stderr.write(`bridge cli fatal: ${String(error)}\n`);
    process.exit(1);
  },
);
