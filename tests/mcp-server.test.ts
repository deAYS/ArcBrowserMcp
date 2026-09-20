import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import pkg from "../package.json" with { type: "json" };

/**
 * P01 integration tests: real MCP v2 client fixtures speaking to the real
 * server process over stdio. Nothing here invokes tool handlers directly;
 * every assertion goes through the transport/protocol layer.
 *
 * The primary target is protocol revision 2026-07-28 (modern era): the main
 * fixture pins `versionNegotiation: { mode: { pin: '2026-07-28' } }` so a
 * legacy-only server would fail loudly instead of passing by fallback. Era
 * is asserted explicitly via `getProtocolEra()`, never inferred from a
 * successful `listTools()` alone.
 *
 * The fixture spawns the compiled protocol test host (dist/testHost.js),
 * which uses the same createServer/serveStdio/tool registration as
 * production but injects the disconnected placeholder BrowserService, so
 * protocol tests never launch a browser. A vitest globalSetup build
 * guarantees dist is fresh, because Node's native type stripping does not
 * remap the `.js` import specifiers used by NodeNext ESM sources.
 */

const SERVER_ENTRY = fileURLToPath(new URL("../dist/testHost.js", import.meta.url));
const MODERN_VERSION = "2026-07-28";
const BOUND_MS = 20_000;

interface Fixture {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  stderrText(): string;
}

async function spawnServer(envExtra: Record<string, string> = {}, modern = true): Promise<Fixture> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...getDefaultEnvironment(), ARC_MCP_LOG_LEVEL: "debug", ...envExtra },
    stderr: "pipe",
  });
  let text = "";
  const stderr = transport.stderr;
  if (stderr !== null) {
    stderr.on("data", (chunk: unknown) => {
      text += typeof chunk === "string" ? chunk : String(chunk);
    });
  }
  const client = modern
    ? new Client(
        { name: "arc-mcp-p01-test-client", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: MODERN_VERSION } } },
      )
    : new Client({ name: "arc-mcp-p01-legacy-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport, stderrText: () => text };
}

const openFixtures: Fixture[] = [];

afterEach(async () => {
  while (openFixtures.length > 0) {
    const fixture = openFixtures.pop();
    if (fixture !== undefined) {
      await fixture.client.close();
    }
  }
});

/** Bounded wait for an event-driven condition; timeout means test failure, never a sleep. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

describe("P01-AC1: pinned 2026-07-28 connect, era, and tool discovery", () => {
  it(
    "modern-pinned client negotiates the modern era and lists browser_status",
    async () => {
      const fixture = await spawnServer();
      openFixtures.push(fixture);

      expect(fixture.client.getProtocolEra()).toBe("modern");
      expect(fixture.client.getNegotiatedProtocolVersion()).toBe(MODERN_VERSION);

      const { tools } = await fixture.client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("browser_status");

      const serverVersion = fixture.client.getServerVersion();
      expect(serverVersion?.name).toBe("arc-mcp");
      expect(serverVersion?.version).toBe(pkg.version);
    },
    BOUND_MS,
  );
});

describe("P01-AC1-legacy: default client compatibility", () => {
  it(
    "default (legacy) client can still connect via serveStdio dual-era support",
    async () => {
      const fixture = await spawnServer({}, false);
      openFixtures.push(fixture);

      const { tools } = await fixture.client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("browser_status");
    },
    BOUND_MS,
  );
});

describe("P01-AC2: browser_status over the modern connection", () => {
  it(
    "invokes browser_status and receives disconnected state",
    async () => {
      const fixture = await spawnServer();
      openFixtures.push(fixture);
      expect(fixture.client.getProtocolEra()).toBe("modern");

      const result = await fixture.client.callTool({ name: "browser_status", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        connected: false,
        state: "disconnected",
        profileMode: "dedicated-mcp-profile",
        reason: "browser-engine-not-implemented",
        selectedTabId: null,
      });
    },
    BOUND_MS,
  );
});

describe("P01-AC3: diagnostics on stderr do not corrupt modern MCP stdio", () => {
  it(
    "server logs to stderr while modern protocol traffic succeeds",
    async () => {
      // Debug level maximizes stderr output during the session.
      const fixture = await spawnServer({ ARC_MCP_LOG_LEVEL: "debug" });
      openFixtures.push(fixture);
      expect(fixture.client.getProtocolEra()).toBe("modern");

      const { tools } = await fixture.client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("browser_status");
      const result = await fixture.client.callTool({ name: "browser_status", arguments: {} });
      expect(result.isError).not.toBe(true);

      // Allow piped stderr to flush, then assert diagnostics were emitted
      // while every protocol round-trip above still succeeded.
      await withTimeout(
        (async () => {
          for (;;) {
            if (fixture.stderrText().includes("arc-mcp MCP server started over stdio")) {
              return;
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        })(),
        10_000,
        "startup log line on server stderr",
      );
      expect(fixture.stderrText()).toContain("arc-mcp MCP server started over stdio");
    },
    BOUND_MS,
  );
});

describe("P01-AC4: SIGINT closes the server cleanly", () => {
  it(
    "server shuts down on SIGINT without hanging",
    async () => {
      const fixture = await spawnServer();
      // Owned by this test (not afterEach): the server is expected to exit.
      const { tools } = await fixture.client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("browser_status");

      const closed = new Promise<void>((resolve) => {
        fixture.transport.onclose = () => resolve();
      });
      const pid = fixture.transport.pid;
      expect(pid).not.toBeNull();
      if (pid !== null) {
        process.kill(pid, "SIGINT");
      }
      await withTimeout(closed, 10_000, "server transport close after SIGINT");

      // Windows terminates a process on process.kill(SIGINT) without running
      // handlers (verified empirically: exit code 1, no handler output), so
      // the graceful-stop log is only asserted where the platform delivers
      // SIGINT to handlers. Prompt close with no orphan is asserted everywhere.
      // Authoritative graceful close is covered by the shutdown unit test
      // (StdioServerHandle.close path) instead of an OS signal claim.
      if (process.platform !== "win32") {
        expect(fixture.stderrText()).toContain("arc-mcp stopped");
      }
      if (pid !== null) {
        // ESRCH: the server process is gone.
        expect(() => process.kill(pid, 0)).toThrow();
      }
      await fixture.client.close();
    },
    BOUND_MS,
  );
});
