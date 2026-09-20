import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { BrowserService } from "../../src/browser/BrowserService.js";
import { ArcExtensionEngine } from "../../src/browser/extension/ArcExtensionEngine.js";
import { BridgeRuntime } from "../../src/browser/extension/BridgeRuntime.js";
import { loadExtensionIdentity } from "../../src/bridge/extensionIdentity.js";
import { createServer } from "../../src/server/server.js";

/**
 * Real ArcExtensionEngine + MCP integration (P03C, opt-in via
 * pnpm test:extension-engine; never runs under plain pnpm test).
 *
 * Uses the already-loaded real Arc extension (no tabs, no debugger, no
 * navigation, no UI interaction). MCP transport is an in-memory linked
 * pair served through serveStdio so era ownership stays with the SDK
 * entry point; the client pins modern 2026-07-28.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXPECTED_ID = loadExtensionIdentity(REPO_ROOT).extensionId;
const BOUND_MS = 480_000;

const engine = new ArcExtensionEngine({
  runtime: new BridgeRuntime({}),
  extensionId: EXPECTED_ID,
  connectTimeoutMs: 180_000,
});
let handle: StdioServerHandle | null = null;
let client: Client | null = null;

afterAll(async () => {
  if (client !== null) {
    await client.close().catch(() => undefined);
    client = null;
  }
  if (handle !== null) {
    await handle.close().catch(() => undefined);
    handle = null;
  }
  await engine.disconnect().catch(() => undefined);
}, 60_000);

describe("real extension engine over MCP", () => {
  it(
    "connects, serves browser_status over modern MCP, and survives disconnect/reconnect",
    async () => {
      await engine.connect();
      const connected = await engine.status();
      expect(connected.connected).toBe(true);
      expect(connected.backend).toBe("extension");
      expect(connected.selectedTabId).toBeNull();

      const service = new BrowserService(engine);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      handle = serveStdio(() => createServer(service), { transport: serverTransport });
      const testClient = new Client(
        { name: "arc-mcp-p03c-test-client", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      client = testClient;
      await testClient.connect(clientTransport);
      expect(testClient.getProtocolEra()).toBe("modern");

      const { tools } = await testClient.listTools();
      expect(tools.map((tool) => tool.name)).toContain("browser_status");

      const result = await testClient.callTool({ name: "browser_status", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        connected: true,
        backend: "extension",
        selectedTabId: null,
        extensionId: EXPECTED_ID,
        relayConnected: true,
        pipeAuthenticated: true,
        bridgeProtocolVersion: 1,
      });

      await engine.disconnect();
      const down = await engine.status();
      expect(down.connected).toBe(false);
      const downViaMcp = await testClient.callTool({ name: "browser_status", arguments: {} });
      expect(downViaMcp.structuredContent).toMatchObject({ connected: false });

      await engine.connect();
      const recovered = await testClient.callTool({ name: "browser_status", arguments: {} });
      expect(recovered.structuredContent).toMatchObject({
        connected: true,
        backend: "extension",
        selectedTabId: null,
      });

      await engine.disconnect();
      expect((await engine.status()).connected).toBe(false);
    },
    BOUND_MS,
  );
});
