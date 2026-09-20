import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { BrowserService } from "../../browser/BrowserService.js";
import { ArcError } from "../../errors/ArcError.js";
import { BridgeError } from "../../bridge/BridgeError.js";

const SnapshotNodeSchema = z.object({
  ref: z.string().optional(),
  role: z.string(),
  name: z.string().optional(),
  value: z.string().optional(),
  description: z.string().optional(),
  disabled: z.boolean().optional(),
  focused: z.boolean().optional(),
  selected: z.boolean().optional(),
  checked: z.union([z.boolean(), z.literal("mixed")]).optional(),
  expanded: z.boolean().optional(),
  level: z.number().optional(),
});

const SnapshotResultSchema = z.object({
  snapshotId: z.string(),
  tabId: z.string(),
  url: z.string(),
  title: z.string(),
  nodes: z.array(SnapshotNodeSchema),
  text: z.string(),
  truncated: z.boolean(),
  totalNodes: z.number(),
  includedNodes: z.number(),
});

export interface SnapshotToolServices {
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
 * Snapshot tool registration (P06, read-only). Acts only on the logically
 * selected tab; depends solely on BrowserService. No tabId, no CDP
 * parameters, no raw Chrome/CDP ids.
 */
export function registerSnapshotTool(server: McpServer, services: SnapshotToolServices): void {
  server.registerTool(
    "browser_snapshot",
    {
      title: "Snapshot page",
      description:
        "Capture a read-only semantic Accessibility snapshot of the selected tab with opaque element refs for later interaction.",
      inputSchema: z.object({ maxNodes: z.number().int().positive().max(1500).optional() }),
      outputSchema: SnapshotResultSchema,
    },
    (args) =>
      callTool(() =>
        args.maxNodes === undefined ? services.browser.snapshot() : services.browser.snapshot({ maxNodes: args.maxNodes }),
      ),
  );
}
