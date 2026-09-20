import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { BrowserService } from "../../browser/BrowserService.js";
import { ArcError } from "../../errors/ArcError.js";
import { BridgeError } from "../../bridge/BridgeError.js";

const NavigationTabSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  active: z.boolean(),
  pinned: z.boolean(),
  windowId: z.number(),
  controllable: z.boolean(),
});

const NavigateResultSchema = z.object({
  action: z.literal("navigate"),
  accepted: z.literal(true),
  requestedUrl: z.string(),
  tab: NavigationTabSchema,
});

const HistoryResultSchema = z.object({
  action: z.enum(["back", "forward", "reload"]),
  accepted: z.literal(true),
  tab: NavigationTabSchema,
});

export interface NavigationToolServices {
  readonly browser: BrowserService;
}

/** Domain errors become MCP tool errors carrying the stable error code. */
function toToolError(error: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  const code =
    error instanceof ArcError
      ? error.code
      : error instanceof BridgeError
        ? error.code
        : "UNKNOWN_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `${code}: ${message}` }], isError: true };
}

async function callTool<T>(action: () => Promise<T>): Promise<
  | { content: [{ type: "text"; text: string }]; structuredContent: T }
  | { content: [{ type: "text"; text: string }]; isError: true }
> {
  try {
    const result = await action();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  } catch (error: unknown) {
    return toToolError(error);
  }
}

/**
 * Navigation tool registration (P05). Tools operate on the logically
 * selected tab only and depend solely on BrowserService.
 */
export function registerNavigationTools(server: McpServer, services: NavigationToolServices): void {
  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate",
      description: "Navigate the selected tab to an allowed HTTP/HTTPS URL.",
      inputSchema: z.object({ url: z.string() }),
      outputSchema: NavigateResultSchema,
    },
    (args) => callTool(() => services.browser.navigate(args.url)),
  );

  server.registerTool(
    "browser_go_back",
    {
      title: "Go back",
      description: "Navigate the selected tab back in its history.",
      inputSchema: z.object({}),
      outputSchema: HistoryResultSchema,
    },
    () => callTool(() => services.browser.goBack()),
  );

  server.registerTool(
    "browser_go_forward",
    {
      title: "Go forward",
      description: "Navigate the selected tab forward in its history.",
      inputSchema: z.object({}),
      outputSchema: HistoryResultSchema,
    },
    () => callTool(() => services.browser.goForward()),
  );

  server.registerTool(
    "browser_reload",
    {
      title: "Reload",
      description: "Reload the selected tab.",
      inputSchema: z.object({ ignoreCache: z.boolean().optional() }),
      outputSchema: HistoryResultSchema,
    },
    (args) => callTool(() => services.browser.reload(args.ignoreCache)),
  );
}
