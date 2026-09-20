import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { BrowserService } from "../../browser/BrowserService.js";
import { ArcError } from "../../errors/ArcError.js";
import { BridgeError } from "../../bridge/BridgeError.js";

const ConsoleEntrySchema = z.object({
  timestamp: z.string(),
  level: z.enum(["log", "info", "warning", "error", "debug"]),
  text: z.string(),
  source: z
    .object({
      url: z.string().optional(),
      line: z.number().optional(),
      column: z.number().optional(),
    })
    .optional(),
});

const ConsoleResultSchema = z.object({
  tabId: z.string(),
  monitoring: z.literal(true),
  capacity: z.number(),
  availableEntries: z.number(),
  returnedEntries: z.number(),
  droppedCount: z.number(),
  truncated: z.boolean(),
  entries: z.array(ConsoleEntrySchema),
});

const ConsoleClearSchema = z.object({
  cleared: z.literal(true),
  removedEntries: z.number(),
  monitoring: z.boolean(),
});

const NetworkEntrySchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  method: z.string(),
  url: z.string(),
  resourceType: z.string().optional(),
  requestHeaders: z.record(z.string(), z.string()),
  hasPostData: z.boolean(),
  status: z.number().optional(),
  statusText: z.string().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  mimeType: z.string().optional(),
  protocol: z.string().optional(),
  fromDiskCache: z.boolean().optional(),
  failed: z.boolean().optional(),
  errorText: z.string().optional(),
});

const NetworkResultSchema = z.object({
  tabId: z.string(),
  monitoring: z.literal(true),
  capacity: z.number(),
  availableEntries: z.number(),
  returnedEntries: z.number(),
  droppedCount: z.number(),
  truncated: z.boolean(),
  entries: z.array(NetworkEntrySchema),
});

const NetworkClearSchema = z.object({
  cleared: z.literal(true),
  removedEntries: z.number(),
  monitoring: z.boolean(),
});

export interface ObservabilityToolServices {
  readonly browser: BrowserService;
}

/**
 * Domain errors become MCP tool errors carrying the stable error code.
 * Error messages are CODE + safe message only: console payloads, header
 * values, URLs, and event bodies never flow through here (the engine maps
 * failures to fixed, code-only messages and validates every envelope).
 */
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

async function callTool(action: () => Promise<unknown>): Promise<
  | { content: [{ type: "text"; text: string }]; structuredContent: unknown }
  | { content: [{ type: "text"; text: string }]; isError: true }
> {
  try {
    const result = await action();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  } catch (error: unknown) {
    return toToolError(error);
  }
}

const ObservabilityInputSchema = z.object({
  action: z.enum(["get", "clear"]).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

/**
 * P09 observability registration. Both tools act only on the logically
 * selected tab through BrowserService; there are no tabId, CDP, selector,
 * or event parameters. Read-only for the page: get/clear never navigate,
 * reload, mutate, or invalidate snapshot refs.
 */
export function registerObservabilityTools(server: McpServer, services: ObservabilityToolServices): void {
  server.registerTool(
    "browser_console",
    {
      title: "Console entries",
      description:
        "Read or clear bounded console entries for the selected tab. Read-only for the page; does not invalidate refs.",
      inputSchema: ObservabilityInputSchema,
      outputSchema: z.union([ConsoleResultSchema, ConsoleClearSchema]),
    },
    (args) =>
      callTool(() => {
        if (args.action === "clear") {
          return services.browser.clearConsole();
        }
        return args.limit === undefined
          ? services.browser.getConsole()
          : services.browser.getConsole(args.limit);
      }),
  );

  server.registerTool(
    "browser_network",
    {
      title: "Network entries",
      description:
        "Read or clear bounded request/response metadata for the selected tab (no bodies). Read-only for the page; does not invalidate refs.",
      inputSchema: ObservabilityInputSchema,
      outputSchema: z.union([NetworkResultSchema, NetworkClearSchema]),
    },
    (args) =>
      callTool(() => {
        if (args.action === "clear") {
          return services.browser.clearNetwork();
        }
        return args.limit === undefined
          ? services.browser.getNetwork()
          : services.browser.getNetwork(args.limit);
      }),
  );
}
