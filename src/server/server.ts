import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { BrowserService } from "../browser/BrowserService.js";
import { registerStatusTool } from "./tools/status.js";
import { registerTabsTools } from "./tools/tabs.js";
import { registerNavigationTools } from "./tools/navigation.js";
import { registerSnapshotTool } from "./tools/snapshot.js";
import { registerInteractionTools } from "./tools/interaction.js";
import { registerPageTools } from "./tools/pageTools.js";
import { registerObservabilityTools } from "./tools/observability.js";

/** Single source of truth for the server version: package.json. */
function readPackageVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../../package.json") as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("arc-mcp: package.json version is missing or invalid");
  }
  return pkg.version;
}

/**
 * Create and configure a fresh McpServer. Used as the `serveStdio` factory,
 * so every stdio connection gets its own configured instance.
 *
 * The BrowserService is injected: production passes the engine-backed
 * service, while protocol tests pass the disconnected placeholder.
 */
export function createServer(browser: BrowserService = new BrowserService()): McpServer {
  const server = new McpServer(
    { name: "arc-mcp", version: readPackageVersion() },
    { capabilities: { tools: {} } },
  );
  registerStatusTool(server, { browser });
  registerTabsTools(server, { browser });
  registerNavigationTools(server, { browser });
  registerSnapshotTool(server, { browser });
  registerInteractionTools(server, { browser });
  registerPageTools(server, { browser });
  registerObservabilityTools(server, { browser });
  return server;
}
