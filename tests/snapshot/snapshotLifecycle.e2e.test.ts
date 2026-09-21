import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { BrowserService } from "../../src/browser/BrowserService.js";

import { arcSpec } from "../../src/browser/chromium/spec.js";
import { ExtensionEngine } from "../../src/browser/extension/ExtensionEngine.js";
import { BridgeRuntime } from "../../src/browser/extension/BridgeRuntime.js";
import { loadExtensionIdentity } from "../../src/bridge/extensionIdentity.js";
import { createServer } from "../../src/server/server.js";

/**
 * Real snapshot lifecycle over MCP (opt-in via pnpm test:snapshot;
 * never runs under plain pnpm test). Disposable tab only; pre-existing
 * user tabs are recorded first and must remain present with unchanged
 * URLs/pinned state at the end. No click/type/evaluate/screenshot.
 *
 * about:blank policy: the disposable no-URL new tab in Arc is a privileged
 * new-tab page (chrome://newtab), used for the negative case.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXPECTED_ID = loadExtensionIdentity(REPO_ROOT).extensionId;
const BOUND_MS = 480_000;
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

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
  disabled?: boolean;
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

const engineRuntime = new BridgeRuntime({});
const engine = new ExtensionEngine({
    spec: arcSpec(),
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

async function pollTabCommitted(tabId: string, expectedUrl: string): Promise<TabRecord> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let stableCount = 0;
  let last: TabRecord | undefined;
  for (;;) {
    const listed = structuredTabs(await callTool("browser_list_tabs"));
    last = listed.tabs.find((tab) => tab.id === tabId);
    if (last === undefined) {
      throw new Error(`disposable tab ${tabId} disappeared during snapshot polling`);
    }
    if (last.url === expectedUrl && last.title === "Example Domain") {
      stableCount += 1;
      if (stableCount >= 2) {
        return last;
      }
    } else {
      stableCount = 0;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${tabId} to commit ${expectedUrl} (last: ${JSON.stringify(last)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

afterAll(async () => {
  if (client !== null && ownedTabIds.size > 0) {
    for (const tabId of [...ownedTabIds]) {
      try {
        await client.callTool({ name: "browser_close_tab", arguments: { tabId } });
      } catch {
        // Already gone is fine.
      }
      ownedTabIds.delete(tabId);
    }
  }
  if (client !== null) {
    await client.close().catch(() => undefined);
    client = null;
  }
  if (handle !== null) {
    await handle.close().catch(() => undefined);
    handle = null;
  }
  await engine.disconnect().catch(() => undefined);
}, 120_000);

describe("real snapshot lifecycle over MCP", () => {
  it(
    "captures semantic snapshots of a disposable tab with opaque refs and generation lifecycle",
    async () => {
      await engine.connect();
      const startedAt = Date.now();
      const service = new BrowserService(engine);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      handle = serveStdio(() => createServer(service), { transport: serverTransport });
      const testClient = new Client(
        { name: "arc-mcp-snapshot-test-client", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      client = testClient;
      await testClient.connect(clientTransport);

      const before = structuredTabs(await callTool("browser_list_tabs"));
      const preexisting = before.tabs.map((tab) => ({ id: tab.id, url: tab.url, pinned: tab.pinned }));

      const opened = await callTool("browser_open_tab", { url: "https://example.com/" });
      expect(opened.isError).not.toBe(true);
      const openedTab = (opened.structuredContent as { tab: TabRecord }).tab;
      ownedTabIds.add(openedTab.id);
      await pollTabCommitted(openedTab.id, "https://example.com/");

      const first = structuredSnapshot(await callTool("browser_snapshot", {}));
      const captureMs = Date.now() - startedAt;
      expect(first.tabId).toBe(openedTab.id);
      expect(first.url).toBe("https://example.com/");
      expect(first.title).toBe("Example Domain");
      expect(first.snapshotId).toMatch(/^s-[0-9a-f]{32}-[0-9a-z]+$/);
      expect(first.nodes.some((node) => node.role === "heading" && node.name === "Example Domain")).toBe(true);
      expect(first.nodes.some((node) => node.role === "link" && node.name === "Learn more")).toBe(true);
      const firstLink = first.nodes.find((node) => node.role === "link" && node.name === "Learn more");
      expect(firstLink?.ref).toMatch(/^e-[0-9a-f]{32}-[0-9a-z]+-[0-9a-z]+$/);
      expect(JSON.stringify(first)).not.toContain("backendNodeId");
      expect(JSON.stringify(first)).not.toContain("nodeId");
      expect(JSON.stringify(first)).not.toContain("objectId");

      const second = structuredSnapshot(await callTool("browser_snapshot", {}));
      expect(second.tabId).toBe(openedTab.id);
      expect(second.snapshotId).not.toBe(first.snapshotId);

      const navigated = await callTool("browser_navigate", { url: "https://example.com/" });
      expect(navigated.isError).not.toBe(true);
      await pollTabCommitted(openedTab.id, "https://example.com/");
      const third = structuredSnapshot(await callTool("browser_snapshot", {}));
      expect(third.tabId).toBe(openedTab.id);
      expect(third.snapshotId).not.toBe(second.snapshotId);
      expect(JSON.stringify(third)).not.toContain(firstLink?.ref ?? "e-impossible-ref");

      // Privileged negative: disposable no-URL new tab is not controllable.
      const blank = await callTool("browser_open_tab", {});
      const blankTab = (blank.structuredContent as { tab: TabRecord }).tab;
      ownedTabIds.add(blankTab.id);
      const privileged = await callTool("browser_snapshot", {});
      expect(privileged.isError).toBe(true);
      expect(JSON.stringify(privileged.content)).toContain("BROWSER_TAB_NOT_CONTROLLABLE");

      // Restore the disposable web tab as selected, then clean up owned tabs.
      await callTool("browser_select_tab", { tabId: openedTab.id });
      for (const tabId of [...ownedTabIds]) {
        await callTool("browser_close_tab", { tabId });
        ownedTabIds.delete(tabId);
      }

      const after = structuredTabs(await callTool("browser_list_tabs"));
      for (const snapshot of preexisting) {
        const current = after.tabs.find((tab) => tab.id === snapshot.id);
        expect(current, `pre-existing tab ${snapshot.id} must survive`).toBeDefined();
        expect(current?.url).toBe(snapshot.url);
        expect(current?.pinned).toBe(snapshot.pinned);
      }
      expect((await engine.status()).connected).toBe(true);
      expect(captureMs).toBeLessThan(BOUND_MS);
      await engine.disconnect();
    },
    BOUND_MS,
  );
});
