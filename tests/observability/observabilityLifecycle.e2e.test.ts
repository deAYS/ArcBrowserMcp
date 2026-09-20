import { fileURLToPath } from "node:url";
import * as http from "node:http";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { BrowserService } from "../../src/browser/BrowserService.js";
import { ArcExtensionEngine } from "../../src/browser/extension/ArcExtensionEngine.js";
import { BridgeRuntime } from "../../src/browser/extension/BridgeRuntime.js";
import { loadExtensionIdentity } from "../../src/bridge/extensionIdentity.js";
import { createServer } from "../../src/server/server.js";

/**
 * Real console/network observability over MCP (opt-in via
 * pnpm test:observability; never runs under plain pnpm test).
 * Deterministic disposable fixture served ONLY from 127.0.0.1 on an
 * ephemeral port (test infrastructure only; not a product listener).
 * Pre-existing user tabs are recorded first and must remain present with
 * unchanged URLs/pinned state; the originally active tab is restored.
 * Existing user pages are never observed, evaluated, or inspected.
 *
 * DO NOT RUN against a stale extension worker: rebuild the extension
 * before this suite runs.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXPECTED_ID = loadExtensionIdentity(REPO_ROOT).extensionId;
const BOUND_MS = 480_000;
const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 750;
const CONSOLE_POLL_TIMEOUT_MS = 60_000;
const NETWORK_POLL_TIMEOUT_MS = 60_000;

interface TabRecord {
  id: string;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
  windowId: number;
  controllable: boolean;
}

interface SnapshotNode {
  ref?: string;
  role: string;
  name?: string;
  value?: string;
}

interface SnapshotPayload {
  snapshotId: string;
  tabId: string;
  url: string;
  title: string;
  nodes: SnapshotNode[];
  text: string;
  truncated: boolean;
  totalNodes: number;
  includedNodes: number;
}

interface ConsolePayload {
  tabId: string;
  monitoring: boolean;
  capacity: number;
  availableEntries: number;
  returnedEntries: number;
  droppedCount: number;
  truncated: boolean;
  entries: Array<{ timestamp: string; level: string; text: string; source?: { url?: string; line?: number; column?: number } }>;
}

interface NetworkPayload {
  tabId: string;
  monitoring: boolean;
  capacity: number;
  availableEntries: number;
  returnedEntries: number;
  droppedCount: number;
  truncated: boolean;
  entries: Array<{
    id: string;
    startedAt: string;
    method: string;
    url: string;
    resourceType?: string;
    requestHeaders: Record<string, string>;
    hasPostData: boolean;
    status?: number;
    statusText?: string;
    responseHeaders?: Record<string, string>;
    mimeType?: string;
    protocol?: string;
    failed?: boolean;
    errorText?: string;
  }>;
}

const REQUEST_BODY_SENTINEL = "live-request-body-sentinel-must-never-appear";
const RESPONSE_BODY_SENTINEL = "live-response-body-sentinel-must-never-appear";
const URL_SECRET_PARAM = "live_url_secret_must_be_redacted";

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture Home</title></head>
<body>
<h1>Fixture</h1>
<div id="status" role="status">status: ready</div>
<button id="trigger" type="button">Trigger observability</button>
<script>
document.getElementById("trigger").addEventListener("click", async () => {
  console.log("fixture-marker-log");
  console.warn("fixture-marker-warn");
  console.error("fixture-marker-error");
  try {
    const response = await fetch("./api/data?access_token=${URL_SECRET_PARAM}&page=2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Safe": "safe-value" },
      body: JSON.stringify({ note: "${REQUEST_BODY_SENTINEL}" })
    });
    await response.text();
    document.getElementById("status").textContent = "status: triggered";
  } catch (err) {
    document.getElementById("status").textContent = "status: fetch-failed";
  }
});
</script>
</body></html>`;

let fixtureBase = "";
let fixtureServer: http.Server | null = null;

async function startFixture(): Promise<string> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
      return;
    }
    if (url.pathname === "/api/data") {
      // Drain the request body (proves postData is available to the page
      // but must never appear in observability output), then answer with a
      // JSON body carrying a sentinel that must also never appear.
      let received = 0;
      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
      });
      req.on("end", () => {
        void received;
        const body = JSON.stringify({ ok: true, echo: "RESPONSE_BODY_SENTINEL_PLACEHOLDER" }).replace(
          "RESPONSE_BODY_SENTINEL_PLACEHOLDER",
          RESPONSE_BODY_SENTINEL,
        );
        // Sensitive response header (exposed to CDP where Chrome provides
        // it); safe header alongside for the preserved-header assertion.
        res.writeHead(200, {
          "content-type": "application/json",
          "X-Test-Safe-Response": "safe-response-value",
          "X-Api-Key": "live-response-key-must-be-redacted",
        });
        res.end(body);
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  fixtureServer = server;
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("fixture server has no address");
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

const engineRuntime = new BridgeRuntime({});
const engine = new ArcExtensionEngine({
  runtime: engineRuntime,
  extensionId: EXPECTED_ID,
  connectTimeoutMs: 180_000,
});
let handle: StdioServerHandle | null = null;
let client: Client | null = null;
const ownedTabIds = new Set<string>();
let runtimeRequestBaseline: BridgeRuntime["request"] | null = null;

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  if (client === null) {
    throw new Error("MCP client not connected");
  }
  return client.callTool({ name, arguments: args });
}

function structuredTabs(result: CallToolResult): { tabs: TabRecord[]; selectedTabId: string | null } {
  expect(result.isError).not.toBe(true);
  const payload = result.structuredContent as { tabs?: TabRecord[]; selectedTabId?: string | null } | undefined;
  expect(Array.isArray(payload?.tabs)).toBe(true);
  return { tabs: payload?.tabs ?? [], selectedTabId: payload?.selectedTabId ?? null };
}

function structuredSnapshot(result: CallToolResult): SnapshotPayload {
  if (result.isError === true) {
    throw new Error(`browser_snapshot failed: ${JSON.stringify(result.content).slice(0, 800)}`);
  }
  const payload = result.structuredContent as SnapshotPayload | undefined;
  expect(typeof payload?.snapshotId).toBe("string");
  expect(Array.isArray(payload?.nodes)).toBe(true);
  return payload as SnapshotPayload;
}

function structuredConsole(result: CallToolResult, label: string): ConsolePayload {
  if (result.isError === true) {
    throw new Error(`${label} failed: ${JSON.stringify(result.content).slice(0, 800)}`);
  }
  const payload = result.structuredContent as ConsolePayload | undefined;
  expect(typeof payload?.tabId).toBe("string");
  expect(Array.isArray(payload?.entries)).toBe(true);
  return payload as ConsolePayload;
}

function structuredNetwork(result: CallToolResult, label: string): NetworkPayload {
  if (result.isError === true) {
    throw new Error(`${label} failed: ${JSON.stringify(result.content).slice(0, 800)}`);
  }
  const payload = result.structuredContent as NetworkPayload | undefined;
  expect(typeof payload?.tabId).toBe("string");
  expect(Array.isArray(payload?.entries)).toBe(true);
  return payload as NetworkPayload;
}

function toolErrorCode(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const text = JSON.stringify(result.content);
  const match = /"text":"([A-Z0-9_]+):/.exec(text) ?? /([A-Z0-9_]+):/.exec(text);
  return match?.[1] ?? text.slice(0, 80);
}

async function pollTabCommitted(tabId: string, expectedUrl: string): Promise<TabRecord> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let stableCount = 0;
  let last: TabRecord | undefined;
  for (;;) {
    const listed = structuredTabs(await callTool("browser_list_tabs"));
    last = listed.tabs.find((tab) => tab.id === tabId);
    if (last === undefined) {
      throw new Error(`disposable tab ${tabId} disappeared during fixture polling`);
    }
    if (last.url === expectedUrl && last.title !== "") {
      stableCount += 1;
      if (stableCount >= 2) {
        return last;
      }
    } else {
      stableCount = 0;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${tabId} to commit ${expectedUrl} (last: ${JSON.stringify(last)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function pollOwnedTabsGone(tabIds: string[]): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const listed = structuredTabs(await callTool("browser_list_tabs"));
    const remaining = tabIds.filter((id) => listed.tabs.some((tab) => tab.id === id));
    if (remaining.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`owned tabs did not disappear: ${remaining.join(",")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function headingRef(snapshot: SnapshotPayload): string {
  const node = snapshot.nodes.find((entry) => entry.role === "heading" && entry.ref !== undefined);
  if (node?.ref === undefined) {
    throw new Error(`no heading ref in snapshot ${snapshot.snapshotId}`);
  }
  return node.ref;
}

function buttonRef(snapshot: SnapshotPayload, name: string): string {
  const node = snapshot.nodes.find((entry) => entry.role === "button" && entry.name === name && entry.ref !== undefined);
  if (node?.ref === undefined) {
    throw new Error(`no button ref ${JSON.stringify(name)} in snapshot ${snapshot.snapshotId}`);
  }
  return node.ref;
}

afterAll(async () => {
  const withTimeout = async (_label: string, work: () => Promise<unknown>, ms = 10_000): Promise<void> => {
    try {
      await Promise.race([
        work().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, ms)),
      ]);
    } catch {
      // Best effort only.
    }
  };
  if (client !== null && ownedTabIds.size > 0) {
    for (const tabId of [...ownedTabIds]) {
      const current = client;
      await withTimeout("close owned tab", () =>
        current.callTool({ name: "browser_close_tab", arguments: { tabId } }),
      );
      ownedTabIds.delete(tabId);
    }
  }
  if (client !== null) {
    const current = client;
    client = null;
    await withTimeout("client.close", () => current.close());
  }
  engineRuntime.request = runtimeRequestBaseline ?? engineRuntime.request;
  if (handle !== null) {
    const current = handle;
    handle = null;
    await withTimeout("handle.close", () => current.close());
  }
  await withTimeout("engine.disconnect", () => engine.disconnect());
  if (fixtureServer !== null) {
    const current = fixtureServer;
    fixtureServer = null;
    await withTimeout("fixture.close", () => new Promise<void>((resolve) => current.close(() => resolve())));
  }
}, 120_000);

describe("real observability over MCP", () => {
  it(
    "browser_console/browser_network against a disposable localhost fixture",
    async () => {
      fixtureBase = await startFixture();
      const fixtureUrl = `${fixtureBase}/`;
      await engine.connect();
      const status = await engine.status();
      expect(status.connected).toBe(true);
      const service = new BrowserService(engine);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      handle = serveStdio(() => createServer(service), { transport: serverTransport });
      const testClient = new Client(
        { name: "arc-mcp-observability-test-client", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      client = testClient;
      await testClient.connect(clientTransport);

      const tools = (await testClient.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain("browser_console");
      expect(tools).toContain("browser_network");

      // Bridge-traffic spy (test-only): proves privileged rejections happen
      // before any observability enable traffic.
      const bridgeTraffic = { consoleGet: 0, consoleClear: 0, networkGet: 0, networkClear: 0 };
      if (runtimeRequestBaseline === null) {
        runtimeRequestBaseline = engineRuntime.request.bind(engineRuntime);
      }
      const originalRuntimeRequest = runtimeRequestBaseline;
      engineRuntime.request = async (
        method: Parameters<BridgeRuntime["request"]>[0],
        payload?: Parameters<BridgeRuntime["request"]>[1],
        timeoutMs?: Parameters<BridgeRuntime["request"]>[2],
      ) => {
        if (method === "observability.consoleGet") {
          bridgeTraffic.consoleGet += 1;
        } else if (method === "observability.consoleClear") {
          bridgeTraffic.consoleClear += 1;
        } else if (method === "observability.networkGet") {
          bridgeTraffic.networkGet += 1;
        } else if (method === "observability.networkClear") {
          bridgeTraffic.networkClear += 1;
        }
        return originalRuntimeRequest.call(engineRuntime, method, payload ?? {}, timeoutMs);
      };

      const before = structuredTabs(await callTool("browser_list_tabs"));
      const preexisting = before.tabs.map((tab) => ({ id: tab.id, url: tab.url, pinned: tab.pinned }));
      const originallyActive = before.tabs.find((tab) => tab.active)?.id ?? null;

      const opened = await callTool("browser_open_tab", { url: fixtureUrl });
      expect(opened.isError).not.toBe(true);
      const openedTab = (opened.structuredContent as { tab: TabRecord }).tab;
      ownedTabIds.add(openedTab.id);
      await pollTabCommitted(openedTab.id, fixtureUrl);

      // Arm monitoring: first gets may legitimately return no entries.
      const armedConsole = structuredConsole(await callTool("browser_console", { action: "get" }), "arm console");
      expect(armedConsole.monitoring).toBe(true);
      expect(armedConsole.tabId).toBe(openedTab.id);
      const armedNetwork = structuredNetwork(await callTool("browser_network", { action: "get" }), "arm network");
      expect(armedNetwork.monitoring).toBe(true);
      expect(armedNetwork.tabId).toBe(openedTab.id);

      // Stable ref before triggering.
      let snapshot = structuredSnapshot(await callTool("browser_snapshot", {}));
      expect(snapshot.tabId).toBe(openedTab.id);
      const triggerRef = buttonRef(snapshot, "Trigger observability");

      // Trigger fixture behavior via semantic click.
      const clicked = await callTool("browser_click", { ref: triggerRef });
      expect(clicked.isError).not.toBe(true);

      // Bounded poll for the console marker.
      let consoleResult: ConsolePayload | null = null;
      {
        const deadline = Date.now() + CONSOLE_POLL_TIMEOUT_MS;
        for (;;) {
          const current = structuredConsole(await callTool("browser_console", { action: "get" }), "poll console");
          if (current.entries.some((entry) => entry.text.includes("fixture-marker-log"))) {
            consoleResult = current;
            break;
          }
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for console marker (last: ${JSON.stringify(current).slice(0, 600)})`);
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      }
      expect(consoleResult).not.toBeNull();
      // Expected marker + level + timestamp + source, no raw CDP ids.
      const marker = consoleResult?.entries.find((entry) => entry.text.includes("fixture-marker-log"));
      expect(marker?.level).toBe("log");
      expect(typeof marker?.timestamp).toBe("string");
      expect((marker?.timestamp ?? "").length).toBeGreaterThan(0);
      const warnEntry = consoleResult?.entries.find((entry) => entry.text.includes("fixture-marker-warn"));
      expect(warnEntry?.level).toBe("warning");
      const errorEntry = consoleResult?.entries.find((entry) => entry.text.includes("fixture-marker-error"));
      expect(errorEntry?.level).toBe("error");
      expect(JSON.stringify(consoleResult)).not.toContain("objectId");
      expect(JSON.stringify(consoleResult)).not.toContain("executionContextId");
      expect(JSON.stringify(consoleResult)).not.toContain("requestId");

      // Bounded poll for the network request.
      let networkResult: NetworkPayload | null = null;
      {
        const deadline = Date.now() + NETWORK_POLL_TIMEOUT_MS;
        for (;;) {
          const current = structuredNetwork(await callTool("browser_network", { action: "get" }), "poll network");
          if (current.entries.some((entry) => entry.url.includes("/api/data"))) {
            networkResult = current;
            break;
          }
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for network request (last: ${JSON.stringify(current).slice(0, 600)})`);
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      }
      expect(networkResult).not.toBeNull();
      const apiEntry = networkResult?.entries.find((entry) => entry.url.includes("/api/data"));
      expect(apiEntry?.method).toBe("POST");
      expect(apiEntry?.status).toBe(200);
      expect(typeof apiEntry?.mimeType).toBe("string");
      expect((apiEntry?.mimeType ?? "").length).toBeGreaterThan(0);
      // URL secret redacted, safe param preserved.
      expect(apiEntry?.url).toContain("access_token=[REDACTED]");
      expect(apiEntry?.url).toContain("page=2");
      expect(apiEntry?.url).not.toContain(URL_SECRET_PARAM);
      // Any sensitive headers Chrome exposed are redacted (live may vary;
      // the mandatory guarantee is proven in mocked tests).
      for (const entry of networkResult?.entries ?? []) {
        for (const [name, value] of Object.entries(entry.requestHeaders)) {
          if (/^(authorization|cookie|proxy-authorization)$/i.test(name)) {
            expect(value).toBe("[REDACTED]");
          }
        }
        for (const [name, value] of Object.entries(entry.responseHeaders ?? {})) {
          if (/^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token)$/i.test(name)) {
            expect(value).toBe("[REDACTED]");
          }
        }
      }
      // No bodies or raw ids anywhere in live output.
      const serializedNetwork = JSON.stringify(networkResult);
      expect(serializedNetwork).not.toContain(REQUEST_BODY_SENTINEL);
      expect(serializedNetwork).not.toContain(RESPONSE_BODY_SENTINEL);
      expect(serializedNetwork).not.toContain("postData");
      expect(serializedNetwork).not.toContain("requestId");
      expect(serializedNetwork).not.toContain("responseBody");

      // Clear semantics: old marker/request gone, monitoring stays usable.
      const consoleClear = await callTool("browser_console", { action: "clear" });
      expect(consoleClear.isError).not.toBe(true);
      expect((consoleClear.structuredContent as { cleared?: boolean }).cleared).toBe(true);
      const networkClear = await callTool("browser_network", { action: "clear" });
      expect(networkClear.isError).not.toBe(true);
      expect((networkClear.structuredContent as { cleared?: boolean }).cleared).toBe(true);
      const afterConsoleClear = structuredConsole(await callTool("browser_console", { action: "get" }), "post-clear console");
      expect(afterConsoleClear.entries.some((entry) => entry.text.includes("fixture-marker-log"))).toBe(false);
      const afterNetworkClear = structuredNetwork(await callTool("browser_network", { action: "get" }), "post-clear network");
      expect(afterNetworkClear.entries.some((entry) => entry.url.includes("/api/data"))).toBe(false);
      expect(afterConsoleClear.monitoring).toBe(true);
      expect(afterNetworkClear.monitoring).toBe(true);

      // Read-only/ref semantics: fresh heading ref survives get/clear cycles.
      snapshot = structuredSnapshot(await callTool("browser_snapshot", {}));
      const freshHeading = headingRef(snapshot);
      const refConsole = await callTool("browser_console", { action: "get" });
      expect(refConsole.isError).not.toBe(true);
      const refNetwork = await callTool("browser_network", { action: "get" });
      expect(refNetwork.isError).not.toBe(true);
      const refConsoleClear = await callTool("browser_console", { action: "clear" });
      expect(refConsoleClear.isError).not.toBe(true);
      const refNetworkClear = await callTool("browser_network", { action: "clear" });
      expect(refNetworkClear.isError).not.toBe(true);
      const refText = await callTool("browser_get_text", { ref: freshHeading });
      expect(refText.isError, "observability must preserve live refs").not.toBe(true);
      expect(JSON.stringify(refText.structuredContent)).toContain("Fixture");

      // Privileged negatives on a disposable test-owned new-tab page.
      const privilegedOpen = await callTool("browser_open_tab", {});
      expect(privilegedOpen.isError).not.toBe(true);
      const privilegedTab = (privilegedOpen.structuredContent as { tab: TabRecord }).tab;
      ownedTabIds.add(privilegedTab.id);
      const privilegedSeen = await (async () => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const listed = structuredTabs(await callTool("browser_list_tabs"));
          const found = listed.tabs.find((tab) => tab.id === privilegedTab.id);
          if (found !== undefined) {
            return found;
          }
          if (Date.now() > deadline) {
            return found;
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      })();
      expect(privilegedSeen, "disposable privileged tab must still be listed").toBeDefined();
      if (privilegedSeen?.url !== undefined && /^https?:/i.test(privilegedSeen.url)) {
        throw new Error(`disposable privileged tab unexpectedly controllable: ${JSON.stringify(privilegedSeen.url)}`);
      }
      const trafficBefore = { ...bridgeTraffic };
      expect(toolErrorCode(await callTool("browser_console", { action: "get" }))).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
      expect(toolErrorCode(await callTool("browser_network", { action: "get" }))).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
      expect(bridgeTraffic.consoleGet).toBe(trafficBefore.consoleGet);
      expect(bridgeTraffic.networkGet).toBe(trafficBefore.networkGet);
      await callTool("browser_select_tab", { tabId: openedTab.id });
      const privilegedClose = await callTool("browser_close_tab", { tabId: privilegedTab.id });
      expect(privilegedClose.isError).not.toBe(true);
      ownedTabIds.delete(privilegedTab.id);
      await pollOwnedTabsGone([privilegedTab.id]);
      expect((await engine.status()).selectedTabId).toBe(openedTab.id);

      // Cleanup: only owned tabs; user tabs untouched; focus restored.
      const owned = [...ownedTabIds];
      for (const tabId of owned) {
        await callTool("browser_close_tab", { tabId });
        ownedTabIds.delete(tabId);
      }
      await pollOwnedTabsGone(owned);
      const after = structuredTabs(await callTool("browser_list_tabs"));
      for (const entry of preexisting) {
        const current = after.tabs.find((tab) => tab.id === entry.id);
        expect(current, `pre-existing tab ${entry.id} must survive`).toBeDefined();
        expect(current?.url).toBe(entry.url);
        expect(current?.pinned).toBe(entry.pinned);
      }
      if (originallyActive !== null && after.tabs.some((tab) => tab.id === originallyActive)) {
        await callTool("browser_select_tab", { tabId: originallyActive });
      }
      expect((await engine.status()).connected).toBe(true);
      await engine.disconnect();
    },
    BOUND_MS,
  );
});
