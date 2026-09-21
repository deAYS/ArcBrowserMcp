import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { BrowserService } from "../../browser/BrowserService.js";
import { BrowserError } from "../../errors/BrowserError.js";
import { BridgeError } from "../../bridge/BridgeError.js";

const EvaluateResultSchema = z.object({
  kind: z.enum(["json", "undefined", "nan", "infinity", "neg-infinity", "neg-zero", "bigint"]),
  value: z.unknown().optional(),
});

const WaitResultSchema = z.object({
  matched: z.literal(true),
  condition: z.enum(["load", "url", "title", "text"]),
  elapsedMs: z.number(),
});

export interface PageToolsServices {
  readonly browser: BrowserService;
}

/**
 * Domain errors become MCP tool errors carrying the stable error code.
 * Error messages are CODE + safe message only: expression source,
 * condition text, and screenshot payloads never flow through here (the
 * engine maps failures to fixed, length-only messages).
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

const WaitConditionSchema = z.union([
  z.object({ type: z.literal("load"), timeoutMs: z.number().int().optional() }),
  z.object({
    type: z.literal("url"),
    match: z.enum(["equals", "contains"]),
    value: z.string(),
    timeoutMs: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("title"),
    match: z.enum(["equals", "contains"]),
    value: z.string(),
    timeoutMs: z.number().int().optional(),
  }),
  z.object({ type: z.literal("text"), value: z.string(), timeoutMs: z.number().int().optional() }),
]);

/**
 * Page-tool registration. Every tool acts only on the logically
 * selected tab through BrowserService; there are no tabId, CDP, selector,
 * or script-context parameters. Screenshot returns proper MCP image
 * content ({ type: "image", data, mimeType }) — never raw base64 as the
 * primary user-visible text.
 */
export function registerPageTools(server: McpServer, services: PageToolsServices): void {
  server.registerTool(
    "browser_evaluate",
    {
      title: "Evaluate JavaScript",
      description:
        "Evaluate JavaScript in the selected controllable page and return a by-value result. Arbitrary page JS may run; refs are invalidated after dispatch.",
      inputSchema: z.object({ expression: z.string(), timeoutMs: z.number().int().optional() }),
      outputSchema: EvaluateResultSchema,
    },
    (args) =>
      callTool(() =>
        args.timeoutMs === undefined
          ? services.browser.evaluate(args.expression)
          : services.browser.evaluate(args.expression, { timeoutMs: args.timeoutMs }),
      ),
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Screenshot viewport",
      description: "Capture the current viewport of the selected tab as PNG. Read-only; does not invalidate refs.",
      inputSchema: z.object({}),
    },
    () =>
      (async (): Promise<
        | { content: [{ type: "image"; data: string; mimeType: string }]; structuredContent: { mimeType: string } }
        | { content: [{ type: "text"; text: string }]; isError: true }
      > => {
        try {
          const result = await services.browser.screenshot();
          return {
            content: [{ type: "image" as const, data: result.dataBase64, mimeType: "image/png" }],
            structuredContent: { mimeType: result.mimeType },
          };
        } catch (error: unknown) {
          return toToolError(error);
        }
      })(),
  );

  server.registerTool(
    "browser_wait_for",
    {
      title: "Wait for condition",
      description:
        "Bounded semantic wait (load/url/title/text) on the selected tab. Read-only; polling never allocates or invalidates refs.",
      inputSchema: z.object({ condition: WaitConditionSchema, timeoutMs: z.number().int().optional() }),
      outputSchema: WaitResultSchema,
    },
    (args) =>
      callTool(() => {
        const condition = args.condition;
        const timeoutMs = args.timeoutMs;
        switch (condition.type) {
          case "load":
            return timeoutMs === undefined
              ? services.browser.waitFor({ type: "load" })
              : services.browser.waitFor({ type: "load", timeoutMs });
          case "url":
            return timeoutMs === undefined
              ? services.browser.waitFor({ type: "url", match: condition.match, value: condition.value })
              : services.browser.waitFor({ type: "url", match: condition.match, value: condition.value, timeoutMs });
          case "title":
            return timeoutMs === undefined
              ? services.browser.waitFor({ type: "title", match: condition.match, value: condition.value })
              : services.browser.waitFor({ type: "title", match: condition.match, value: condition.value, timeoutMs });
          case "text":
            return timeoutMs === undefined
              ? services.browser.waitFor({ type: "text", value: condition.value })
              : services.browser.waitFor({ type: "text", value: condition.value, timeoutMs });
        }
      }),
  );
}
