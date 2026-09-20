import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Logger } from "../utils/logger.js";
import { BrowserService } from "../browser/BrowserService.js";
import { createServer } from "./server.js";

export interface StartStdioOptions {
  readonly browser?: BrowserService;
  readonly onError?: (error: Error) => void;
}

/**
 * Serve MCP over stdio using the SDK v2 entry point for the 2026-07-28
 * protocol era. `serveStdio` pins one factory-built McpServer per connection
 * and serves both modern (`server/discover`) and legacy (`initialize`)
 * clients by default.
 *
 * stdout carries MCP protocol traffic only; all diagnostics must go to
 * stderr via the application logger. Nothing here writes to stdout.
 */
export function startStdioServer(options: StartStdioOptions = {}): StdioServerHandle {
  const browser = options.browser ?? new BrowserService();
  const serveOptions = options.onError === undefined ? {} : { onerror: options.onError };
  const handle = serveStdio(() => createServer(browser), serveOptions);
  let closed = false;
  return {
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await handle.close();
    },
  };
}

/**
 * Process-boundary shutdown logic: idempotent, closes the MCP transport,
 * then runs optional teardown (e.g. browser disconnect), and records
 * failures via exit code. Pure enough to unit test without signals/stdout.
 */
export function createShutdownHandler(
  handle: StdioServerHandle,
  logger: Logger,
  teardown?: () => Promise<void>,
): (signal: string) => void {
  let shuttingDown = false;
  return (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("arc-mcp shutting down", { signal });
    handle
      .close()
      .then(() => teardown?.())
      .then(
        () => {
          logger.info("arc-mcp stopped");
        },
        (error: unknown) => {
          logger.error("arc-mcp error during shutdown", { error: String(error) });
          process.exitCode = 1;
        },
      );
  };
}
