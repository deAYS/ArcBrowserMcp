import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/index.js";
import { browserSpec } from "./browser/chromium/spec.js";
import { createLogger } from "./utils/logger.js";
import { BrowserService } from "./browser/BrowserService.js";
import { ExtensionEngine } from "./browser/extension/ExtensionEngine.js";
import { BridgeRuntime } from "./browser/extension/BridgeRuntime.js";
import { extensionOrigin, loadExtensionIdentity } from "./bridge/extensionIdentity.js";
import { BridgeError } from "./bridge/BridgeError.js";
import { createShutdownHandler, startStdioServer } from "./server/transport.js";

/**
 * Production entry point (extension backend): construct the bridge
 * runtime and ExtensionEngine for the configured browser, connect
 * (bounded wait for the running browser's extension), then serve MCP.
 * Browser startup failure is fatal (typed diagnostic + non-zero exit)
 * rather than a fake connected state.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const spec = browserSpec(config.browser);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const identity = loadExtensionIdentity(repoRoot);
  logger.info("arc-mcp extension identity", {
    extensionId: identity.extensionId,
    origin: extensionOrigin(identity.extensionId),
  });
  // Assigned once the stdio server exists; the orphan watchdog above can
  // only fire after engine.connect(), so the no-op default is never used.
  let shutdown: (signal: string) => void = () => undefined;
  // Stdin EOF means the MCP client closed its side: without this the
  // process would linger as a stale pipe owner (GUI closed or workspace
  // switched). Deferred while proxy clients still join this owner.
  let stdinEnded = false;
  let reapDeferred = false;
  const onStdinGone = (): void => {
    stdinEnded = true;
    if (runtime.proxyClientCount() === 0) {
      shutdown("STDIN_EOF");
    } else {
      reapDeferred = true;
    }
  };
  const maybeReap = (): void => {
    if (reapDeferred && runtime.proxyClientCount() === 0) {
      reapDeferred = false;
      shutdown("STDIN_EOF");
    }
  };
  const runtime = new BridgeRuntime({
    logger,
    // Reap orphans: if opencode dies without reaping its MCP child, the
    // child would otherwise hold the pipe forever (PIPE_BUSY for every
    // later session). Assigned below; no-op until startup completes.
    onOrphaned: () => shutdown("PARENT_LOST"),
    onClientsIdle: () => maybeReap(),
  });
  process.stdin.on("end", onStdinGone);
  process.stdin.on("close", onStdinGone);
  const engine = new ExtensionEngine({
    spec,
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

  shutdown = createShutdownHandler(handle, logger, () => engine.disconnect());
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // Replay an EOF that fired before the shutdown handler existed.
  if (stdinEnded && runtime.proxyClientCount() === 0) {
    onStdinGone();
  }
}

main().then(
  () => undefined,
  (error: unknown) => {
    // No logger available here (config may have failed): stderr only, never stdout.
    process.stderr.write(`arc-mcp fatal startup error: ${String(error)}\n`);
    process.exitCode = 1;
  },
);
