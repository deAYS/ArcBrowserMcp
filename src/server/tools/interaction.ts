import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { BrowserService } from "../../browser/BrowserService.js";
import { BrowserError } from "../../errors/BrowserError.js";
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
        "Dispatch a supported key/chord (Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space, letters, digits, F1-F12, optional Control/Shift/Alt/Meta) to the selected tab. Invalidates snapshot refs.",
      inputSchema: z.object({ key: z.string() }),
      outputSchema: AcceptedSchema,
    },
    (args) => callTool(() => services.browser.pressKey(args.key)),
  );

  server.registerTool(
    "browser_type_human",
    {
      title: "Humanized type",
      description:
        "Type text with human-like chunk pacing (one call fans out to many CDP inserts with WPM timing). Use for humanized form entry; invalidates snapshot refs.",
      inputSchema: z.object({ ref: z.string(), text: z.string(), wpm: z.number().int().min(20).max(200).optional() }),
      outputSchema: AcceptedSchema,
    },
    (args) =>
      callTool(() =>
        args.wpm === undefined
          ? services.browser.typeHuman(args.ref, args.text)
          : services.browser.typeHuman(args.ref, args.text, { wpm: args.wpm }),
      ),
  );

  server.registerTool(
    "browser_press_sequence",
    {
      title: "Press key sequence",
      description:
        "Press an ordered key sequence with inter-key delay in one call (e.g. shortcuts, multi-step dismissal). Invalidates snapshot refs.",
      inputSchema: z.object({
        keys: z.array(z.string()).min(1).max(50),
        delayMs: z.number().int().min(0).max(2000).optional(),
      }),
      outputSchema: AcceptedSchema,
    },
    (args) =>
      callTool(() =>
        args.delayMs === undefined
          ? services.browser.pressSequence(args.keys)
          : services.browser.pressSequence(args.keys, { delayMs: args.delayMs }),
      ),
  );

  server.registerTool(
    "browser_click_type",
    {
      title: "Click then type",
      description:
        "Real mouse click then type (optionally humanized) plus an optional submit key — login/search in one call. Invalidates snapshot refs.",
      inputSchema: z.object({
        ref: z.string(),
        text: z.string(),
        humanize: z.boolean().optional(),
        wpm: z.number().int().min(20).max(200).optional(),
        submitKey: z.string().optional(),
      }),
      outputSchema: AcceptedSchema,
    },
    (args) =>
      callTool(() =>
        services.browser.clickType(args.ref, args.text, {
          ...(args.humanize !== undefined ? { humanize: args.humanize } : {}),
          ...(args.wpm !== undefined ? { wpm: args.wpm } : {}),
          ...(args.submitKey !== undefined ? { submitKey: args.submitKey } : {}),
        }),
      ),
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
