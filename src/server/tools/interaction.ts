import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { BrowserService } from "../../browser/BrowserService.js";
import { ArcError } from "../../errors/ArcError.js";
import { BridgeError } from "../../bridge/BridgeError.js";

const AcceptedSchema = z.object({ accepted: z.literal(true) });
const TextResultSchema = z.object({ text: z.string() });

export interface InteractionToolServices {
  readonly browser: BrowserService;
}

/**
 * Domain errors become MCP tool errors carrying the stable error code.
 * Error messages are CODE + safe message only: fill/type payloads never
 * flow through here (the engine maps failures to length-only messages).
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
 * Interaction tool registration. Every tool acts only on the
 * logically selected tab through BrowserService; refs are opaque
 * latest-snapshot-only element references resolved extension-side.
 */
export function registerInteractionTools(server: McpServer, services: InteractionToolServices): void {
  server.registerTool(
    "browser_click",
    {
      title: "Click element",
      description:
        "Dispatch a real left mouse click to a live snapshot element ref on the selected tab. Invalidates snapshot refs.",
      inputSchema: z.object({ ref: z.string() }),
      outputSchema: AcceptedSchema,
    },
    (args) => callTool(() => services.browser.click(args.ref)),
  );

  server.registerTool(
    "browser_fill",
    {
      title: "Fill editable",
      description:
        "Replace an editable control's text with the supplied text (real keyboard/input mechanics, no script). Invalidates snapshot refs.",
      inputSchema: z.object({ ref: z.string(), text: z.string() }),
      outputSchema: AcceptedSchema,
    },
    (args) => callTool(() => services.browser.fill(args.ref, args.text)),
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type text",
      description:
        "Insert text at the caret without clearing the field (real input mechanics, no script). Invalidates snapshot refs.",
      inputSchema: z.object({ ref: z.string(), text: z.string() }),
      outputSchema: AcceptedSchema,
    },
    (args) => callTool(() => services.browser.type(args.ref, args.text)),
  );

  server.registerTool(
    "browser_press_key",
    {
      title: "Press key",
      description:
        "Dispatch a supported key/chord (Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space, optional Control/Shift/Alt/Meta) to the selected tab. Invalidates snapshot refs.",
      inputSchema: z.object({ key: z.string() }),
      outputSchema: AcceptedSchema,
    },
    (args) => callTool(() => services.browser.pressKey(args.key)),
  );

  server.registerTool(
    "browser_get_text",
    {
      title: "Get element text",
      description:
        "Fresh semantic Accessibility read of a live snapshot element ref. Read-only; password/protected values stay redacted.",
      inputSchema: z.object({ ref: z.string() }),
      outputSchema: TextResultSchema,
    },
    (args) => callTool(() => services.browser.getText(args.ref)),
  );
}
