import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./utils/logger.js";
import { BrowserService } from "./browser/BrowserService.js";
import { ArcExtensionEngine } from "./browser/extension/ArcExtensionEngine.js";
import { BridgeRuntime } from "./browser/extension/BridgeRuntime.js";
import { extensionOrigin, loadExtensionIdentity } from "./bridge/extensionIdentity.js";
import { BridgeError } from "./bridge/BridgeError.js";
import { createShutdownHandler, startStdioServer } from "./server/transport.js";

/**
 * Production entry point (extension-primary backend): construct the bridge
 * runtime and ArcExtensionEngine, connect (bounded wait for the running
 * Arc extension), then serve MCP. Browser startup failure is fatal (typed
 * diagnostic + non-zero exit) rather than a fake connected state. No
 * retry/recovery loops here; those belong to P10.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const identity = loadExtensionIdentity(repoRoot);
  logger.info("arc-mcp extension identity", {
    extensionId: identity.extensionId,
    origin: extensionOrigin(identity.extensionId),
  });
  const runtime = new BridgeRuntime({ logger });
  const engine = new ArcExtensionEngine({
    runtime,
    extensionId: identity.extensionId,
    connectTimeoutMs: config.extensionConnectTimeoutMs,
  });
  const browser = new BrowserService(engine);
  try {
    await engine.connect();
  } catch (error: unknown) {
    const code = error instanceof BridgeError ? error.code : "EXTENSION_CONNECT_TIMEOUT";
    logger.error("arc-mcp browser startup failed", {
      code,
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }
  const status = await engine.status();
  const handle = startStdioServer({
    browser,
    onError: (error: Error) => {
      logger.error("arc-mcp stdio error", { error: error.message });
    },
  });
  logger.info("arc-mcp MCP server started over stdio", {
    backend: status.backend,
    connected: status.connected,
    extensionId: status.extensionId,
  });

  const shutdown = createShutdownHandler(handle, logger, () => engine.disconnect());
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().then(
  () => undefined,
  (error: unknown) => {
    // No logger available here (config may have failed): stderr only, never stdout.
    process.stderr.write(`arc-mcp fatal startup error: ${String(error)}\n`);
    process.exitCode = 1;
  },
);
