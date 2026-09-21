import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { BrowserService } from "../../browser/BrowserService.js";
import { BrowserError } from "../../errors/BrowserError.js";
import { BridgeError } from "../../bridge/BridgeError.js";

const TabSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  active: z.boolean(),
  pinned: z.boolean(),
  windowId: z.number(),
  controllable: z.boolean(),
});

const ListTabsResult = z.object({
  tabs: z.array(TabSchema),
  selectedTabId: z.string().nullable(),
});

const SelectedTabResult = z.object({
  tab: TabSchema,
  selectedTabId: z.string().nullable(),
});

const CloseTabResult = z.object({
  closedTabId: z.string(),
  selectedTabId: z.string().nullable(),
});

export interface TabsToolServices {
  readonly browser: BrowserService;
}

/** Domain errors become MCP tool errors carrying the stable error code. */
function toToolError(error: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  const code =
    error instanceof BrowserError
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
 * Tab tool registration. MCP tools depend only on BrowserService;
 * bridge method names and Chrome IDs never appear here.
 */
export function registerTabsTools(server: McpServer, services: TabsToolServices): void {
  server.registerTool(
    "browser_list_tabs",
    {
      title: "List tabs",
      description: "List open tabs with stable tab IDs, titles, URLs, and selection state.",
      inputSchema: z.object({}),
      outputSchema: ListTabsResult,
    },
    () => callTool(() => services.browser.listTabs()),
  );

  server.registerTool(
    "browser_select_tab",
    {
      title: "Select tab",
      description: "Select a tab by tab ID for subsequent operations.",
      inputSchema: z.object({ tabId: z.string() }),
      outputSchema: SelectedTabResult,
    },
    (args) => callTool(() => services.browser.selectTab(args.tabId)),
  );

  server.registerTool(
    "browser_open_tab",
    {
      title: "Open tab",
      description: "Open a new tab, optionally at a URL. The new tab becomes selected.",
      inputSchema: z.object({ url: z.string().optional() }),
      outputSchema: SelectedTabResult,
    },
    (args) => callTool(() => services.browser.openTab(args.url)),
  );

  server.registerTool(
    "browser_close_tab",
    {
      title: "Close tab",
      description: "Close a tab by tab ID.",
      inputSchema: z.object({ tabId: z.string() }),
      outputSchema: CloseTabResult,
    },
    (args) => callTool(() => services.browser.closeTab(args.tabId)),
  );
}
