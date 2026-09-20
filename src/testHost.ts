import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createLogger } from "./utils/logger.js";
import { createServer } from "./server/server.js";

/**
 * Minimal MCP protocol test host (NOT production).
 *
 * Uses the same createServer/serveStdio/tool registration as production but
 * injects the disconnected placeholder BrowserService, so protocol tests
 * never launch a browser. Production startup lives in index.ts.
 */
const logger = createLogger("debug");
const handle = serveStdio(() => createServer(), {
  onerror: (error: Error) => {
    logger.error("arc-mcp test host stdio error", { error: error.message });
  },
});
logger.info("arc-mcp MCP server started over stdio", { host: "test" });

const shutdown = (): void => {
  void handle.close().then(
    () => {
      logger.info("arc-mcp stopped");
    },
    (error: unknown) => {
      logger.error("arc-mcp error during shutdown", { error: String(error) });
      process.exitCode = 1;
    },
  );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
