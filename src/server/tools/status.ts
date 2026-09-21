import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { BrowserService } from "../../browser/BrowserService.js";

export const BrowserStatusSchema = z.object({
  connected: z.boolean(),
  state: z.enum(["disconnected", "connecting", "connected", "error"]),
  backend: z.enum(["none", "cdp", "extension"]),
  profileMode: z.enum(["dedicated-mcp-profile", "normal-running-session"]),
  selectedTabId: z.string().nullable(),
  reason: z.string().optional(),
  cdpPort: z.number().optional(),
  discoverySource: z.string().optional(),
  contextCount: z.number().optional(),
  lastErrorCode: z.string().optional(),
  extensionConnected: z.boolean().optional(),
  relayConnected: z.boolean().optional(),
  pipeAuthenticated: z.boolean().optional(),
  bridgeProtocolVersion: z.number().optional(),
  extensionId: z.string().optional(),
});

export interface StatusToolServices {
  readonly browser: BrowserService;
}

/**
 * Register the `browser_status` tool. Small typed registration seam so future
 * tool modules (tabs, navigation, ...) can follow the same pattern without
 * growing `server.ts` into a giant file.
 */
export function registerStatusTool(server: McpServer, services: StatusToolServices): void {
  server.registerTool(
    "browser_status",
    {
      title: "Browser status",
      description:
        "Return browser connection state, selected tab, profile mode, and recoverable diagnostic state.",
      inputSchema: z.object({}),
      outputSchema: BrowserStatusSchema,
    },
    async () => {
      const status = await services.browser.getStatus();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status) }],
        structuredContent: status,
      };
    },
  );
}
