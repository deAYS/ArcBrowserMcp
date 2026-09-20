import { fileURLToPath } from "node:url";
import * as http from "node:http";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { randomBytes } from "node:crypto";
import { BrowserService } from "../../src/browser/BrowserService.js";
import { ArcExtensionEngine } from "../../src/browser/extension/ArcExtensionEngine.js";
import { BridgeRuntime } from "../../src/browser/extension/BridgeRuntime.js";
import { loadExtensionIdentity } from "../../src/bridge/extensionIdentity.js";
import { createServer } from "../../src/server/server.js";

/**
 * Real element interactions over MCP (opt-in via pnpm test:interactions;
 * never runs under plain pnpm test). Deterministic disposable fixture page
 * served from 127.0.0.1 on an ephemeral port (test infrastructure only; not
 * a product listener). Pre-existing user tabs are recorded first and must
 * remain present with unchanged URLs/pinned state; the originally active
 * tab is restored. No Runtime.evaluate, no generic CDP anywhere.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXPECTED_ID = loadExtensionIdentity(REPO_ROOT).extensionId;
const BOUND_MS = 480_000;
const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 750;

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

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Interaction Fixture</title></head>
<body>
<h1>Interaction Fixture</h1>
<label>Name <input id="name" type="text" value="known"></label>
<label>Secret <input id="secret" type="password" value=""></label>
<input id="file" type="file">
<button id="submit" type="button">Submit</button>
<div id="status" role="status">idle</div>
<div id="clicks" role="status">clicks: 0</div>
<script>
const status = document.getElementById("status");
const clicks = document.getElementById("clicks");
let count = 0;
document.getElementById("submit").addEventListener("click", () => {
  count += 1;
  clicks.textContent = "clicks: " + count;
  status.textContent = "clicked";
});
document.getElementById("name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    status.textContent = "enter:" + document.getElementById("name").value;
  }
});
</script>
</body></html>`;

let fixtureUrl = "";
let fixtureServer: http.Server | null = null;

async function startFixture(): Promise<string> {
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
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
  return `http://127.0.0.1:${String(address.port)}/`;
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

function structuredAccepted(result: CallToolResult, label: string): void {
  if (result.isError === true) {
    throw new Error(`${label} failed: ${JSON.stringify(result.content).slice(0, 800)}`);
  }
  expect(result.structuredContent).toEqual({ accepted: true });
}

function structuredText(result: CallToolResult, label: string): string {
  if (result.isError === true) {
    throw new Error(`${label} failed: ${JSON.stringify(result.content).slice(0, 800)}`);
  }
  const payload = result.structuredContent as { text?: unknown } | undefined;
  expect(typeof payload?.text).toBe("string");
  return payload?.text as string;
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
    if (last.url === expectedUrl && last.title === "Interaction Fixture") {
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

function refValueByName(snapshot: SnapshotPayload, name: string): { ref: string; value?: string } {
  const node = snapshot.nodes.find((entry) => entry.name === name && entry.ref !== undefined);
  if (node?.ref === undefined) {
    throw new Error(`no live ref for ${JSON.stringify(name)} in snapshot ${snapshot.snapshotId}`);
  }
  return { ref: node.ref, ...(node.value === undefined ? {} : { value: node.value }) };
}

function pollNameNode(snapshot: SnapshotPayload): SnapshotNode | undefined {
  return snapshot.nodes.find((node) => node.name === "Name" && node.role !== "text" && node.role !== "inlinetextbox");
}

async function pollNodeValue(tabId: string, name: string, expected: string, label: string): Promise<SnapshotPayload> {
  void tabId;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = "";
  let lastDiag = "";
  for (;;) {
    const snapshot = structuredSnapshot(await callTool("browser_snapshot", {}));
    const node = pollNameNode(snapshot);
    last = node?.value ?? "";
    lastDiag = JSON.stringify(node);
    if (last === expected) {
      return snapshot;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${JSON.stringify(name)} value ${JSON.stringify(expected)} (${label}); last=${JSON.stringify(last)} diag=${lastDiag}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function pollStatusText(tabId: string, expected: string, label: string): Promise<SnapshotPayload> {
  void tabId;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const snapshot = structuredSnapshot(await callTool("browser_snapshot", {}));
    if (snapshot.text.includes(expected)) {
      return snapshot;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for fixture status ${JSON.stringify(expected)} (${label})`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

afterAll(async () => {
  // Every teardown step is bounded: after engine.disconnect() the relay is
  // gone, so browser_close_tab RPCs must not hang the hook. The in-test
  // body already closes owned tabs and restores the active tab; this hook
  // is best-effort cleanup only (all steps race a short timeout and close
  // local resources without awaiting the dead bridge).
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

describe("real interactions over MCP", () => {
  it(
    "click/fill/type/pressKey/getText against a disposable localhost fixture",
    async () => {
      fixtureUrl = await startFixture();
      await engine.connect();
      const service = new BrowserService(engine);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      handle = serveStdio(() => createServer(service), { transport: serverTransport });
      const testClient = new Client(
        { name: "arc-mcp-interactions-test-client", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      client = testClient;
      await testClient.connect(clientTransport);

      const tools = (await testClient.listTools()).tools.map((tool) => tool.name);
      for (const name of ["browser_click", "browser_fill", "browser_type", "browser_press_key", "browser_get_text"]) {
        expect(tools).toContain(name);
      }

      const before = structuredTabs(await callTool("browser_list_tabs"));
      const preexisting = before.tabs.map((tab) => ({ id: tab.id, url: tab.url, pinned: tab.pinned }));
      const originallyActive = before.tabs.find((tab) => tab.active)?.id ?? null;

      const opened = await callTool("browser_open_tab", { url: fixtureUrl });
      expect(opened.isError).not.toBe(true);
      const openedTab = (opened.structuredContent as { tab: TabRecord }).tab;
      ownedTabIds.add(openedTab.id);
      await pollTabCommitted(openedTab.id, fixtureUrl);

      // Snapshot: identify heading/textbox/password/button refs.
      let snapshot = structuredSnapshot(await callTool("browser_snapshot", {}));
      expect(snapshot.tabId).toBe(openedTab.id);
      const { ref: headingRef } = refValueByName(snapshot, "Interaction Fixture");
      const { ref: textboxRef, value: nameBefore } = refValueByName(snapshot, "Name");
      expect(snapshot.nodes.some((node) => node.role === "button" && node.name === "Submit")).toBe(true);

      // getText on the heading: semantic text, read-only so refs stay live.
      // No intervening snapshot here: latest-snapshot-only means any
      // new capture would invalidate textboxRef before the fill below.
      const headingText = structuredText(await callTool("browser_get_text", { ref: headingRef }), "browser_get_text");
      expect(headingText).toContain("Interaction Fixture");

      // fill: replace known content with "hello"; old ref goes stale.
      // Success here also proves getText did not invalidate textboxRef.
      // fill: replace known content with "hello"; old ref goes stale.
      // Success here also proves getText did not invalidate textboxRef.
      // Immediate post-fill snapshot is the replace-semantics evidence
      // (value "known" -> "hello"); the stale-ref probe below intentionally
      // uses the pre-fill ref, then fresh snapshots continue the flow.
      structuredAccepted(await callTool("browser_fill", { ref: textboxRef, text: "hello" }), "browser_fill");
      const afterFillAccepted = structuredSnapshot(await callTool("browser_snapshot", {}));
      expect(pollNameNode(afterFillAccepted)?.value).toBe("hello");
      const staleFill = await callTool("browser_get_text", { ref: textboxRef });
      expect(toolErrorCode(staleFill)).toBe("BROWSER_STALE_ELEMENT");
      snapshot = await pollNodeValue(openedTab.id, "Name", "hello", "fill replace");
      expect(nameBefore).toBe("known");

      // type: insert Unicode without clearing.
      const { ref: textboxRef2 } = refValueByName(snapshot, "Name");
      structuredAccepted(await callTool("browser_type", { ref: textboxRef2, text: " 世界🙂" }), "browser_type");
      snapshot = await pollNodeValue(openedTab.id, "Name", "hello 世界🙂", "type insert");

      // pressKey: Enter in the focused textbox triggers the page handler.
      structuredAccepted(await callTool("browser_press_key", { key: "Enter" }), "browser_press_key");
      snapshot = await pollStatusText(openedTab.id, "enter:hello 世界🙂", "enter handler");

      // password: fill a sentinel secret; snapshot + getText never expose it.
      const sentinel = `test-secret-sentinel-${randomBytes(8).toString("hex")}`;
      const { ref: passwordRef2 } = refValueByName(snapshot, "Secret");
      structuredAccepted(await callTool("browser_fill", { ref: passwordRef2, text: sentinel }), "password fill");
      snapshot = structuredSnapshot(await callTool("browser_snapshot", {}));
      expect(JSON.stringify(snapshot)).not.toContain(sentinel);
      const { ref: passwordRef3 } = refValueByName(snapshot, "Secret");
      const passwordText = structuredText(await callTool("browser_get_text", { ref: passwordRef3 }), "password getText");
      expect(passwordText).not.toContain(sentinel);
      expect(JSON.stringify(snapshot.nodes.find((node) => node.name === "Secret"))).not.toContain(sentinel);

      // click: button dispatches a real mouse interaction; page counter proves it.
      snapshot = structuredSnapshot(await callTool("browser_snapshot", {}));
      const { ref: buttonRef } = refValueByName(snapshot, "Submit");
      structuredAccepted(await callTool("browser_click", { ref: buttonRef }), "browser_click");
      const staleClick = await callTool("browser_click", { ref: buttonRef });
      expect(toolErrorCode(staleClick)).toBe("BROWSER_STALE_ELEMENT");
      await pollStatusText(openedTab.id, "clicks: 1", "button click");

      // Oversized text + invalid key are typed validation errors (no dispatch).
      snapshot = structuredSnapshot(await callTool("browser_snapshot", {}));
      const { ref: textboxRef3 } = refValueByName(snapshot, "Name");
      const oversized = await callTool("browser_fill", { ref: textboxRef3, text: "x".repeat(32 * 1024 + 1) });
      expect(toolErrorCode(oversized)).toBe("BROWSER_INVALID_TEXT");
      const badKey = await callTool("browser_press_key", { key: "F1" });
      expect(toolErrorCode(badKey)).toBe("BROWSER_INVALID_KEY");

      // Cleanup: close only the fixture tab; user tabs untouched; restore focus.
      for (const tabId of [...ownedTabIds]) {
        await callTool("browser_close_tab", { tabId });
        ownedTabIds.delete(tabId);
      }
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
