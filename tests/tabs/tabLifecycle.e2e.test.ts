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
 * Real tab lifecycle over MCP (opt-in via pnpm test:tabs; never runs
 * under plain pnpm test). Uses the already-loaded real Arc extension with
 * disposable tabs only: example.com plus one natural blank tab. Pre-existing
 * user tabs are recorded first and must remain present at the end. No
 * navigation, snapshots, debugger, or UI interaction.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXPECTED_ID = loadExtensionIdentity(REPO_ROOT).extensionId;
const BOUND_MS = 480_000;

interface TabRecord {
  id: string;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
  windowId: number;
  controllable: boolean;
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

function epochOf(id: string): string {
  const parts = id.split("-");
  const epoch = parts[1];
  if (epoch === undefined || !/^[0-9a-f]{32}$/.test(epoch)) {
    throw new Error(`test ID has no epoch: ${id}`);
  }
  return epoch;
}

function expectEpochFormat(ids: readonly string[]): string {
  expect(ids.length).toBeGreaterThan(0);
  const epochs = new Set<string>();
  for (const id of ids) {
    expect(id).toMatch(/^t-[0-9a-f]{32}-\d+(-r\d+)?$/);
    expect(id).not.toMatch(/:\/\//);
    epochs.add(epochOf(id));
  }
  // Raw Chrome numeric IDs must never leak: every ID carries the epoch and
  // no bare integer survives as an identifier.
  expect(epochs.size).toBe(1);
  const epoch = [...epochs][0];
  if (epoch === undefined) {
    throw new Error("expected a single epoch");
  }
  return epoch;
}

afterAll(async () => {
  // Best-effort cleanup of owned disposable tabs only (never user tabs).
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

describe("real tab lifecycle over MCP", () => {
  it(
    "lists, opens, selects, and closes disposable tabs through the full chain",
    async () => {
      await engine.connect();
      const service = new BrowserService(engine);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      handle = serveStdio(() => createServer(service), { transport: serverTransport });
      const testClient = new Client(
        { name: "arc-mcp-tabs-test-client", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      client = testClient;
      await testClient.connect(clientTransport);
      expect(testClient.getProtocolEra()).toBe("modern");

      try {
        // 1-2. Record pre-existing tabs; list works; epoch-qualified IDs.
        const before = structuredTabs(await callTool("browser_list_tabs"));
        const preexisting = new Set(before.tabs.map((tab) => tab.id));
        const startEpoch = expectEpochFormat(before.tabs.map((tab) => tab.id));

        // 3-5. Open disposable tab at example.com; selected; stable on relist.
        const opened = await callTool("browser_open_tab", { url: "https://example.com/" });
        const openedPayload = opened.structuredContent as { tab: TabRecord; selectedTabId: string | null };
        expect(opened.isError).not.toBe(true);
        expect(openedPayload.tab.url).toBe("https://example.com/");
        expect(openedPayload.tab.controllable).toBe(true);
        expect(openedPayload.selectedTabId).toBe(openedPayload.tab.id);
        ownedTabIds.add(openedPayload.tab.id);
        const relisted = structuredTabs(await callTool("browser_list_tabs"));
        expect(relisted.tabs.map((tab) => tab.id)).toContain(openedPayload.tab.id);

        // 6-7. Explicit select; status reflects it.
        const selected = await callTool("browser_select_tab", { tabId: openedPayload.tab.id });
        expect(selected.isError).not.toBe(true);
        const statusAfterSelect = await testClient.callTool({ name: "browser_status", arguments: {} });
        expect(statusAfterSelect.structuredContent).toMatchObject({ selectedTabId: openedPayload.tab.id });

        // 8-9. Second disposable tab (natural blank); distinct ID; selected.
        const blank = await callTool("browser_open_tab", {});
        const blankPayload = blank.structuredContent as { tab: TabRecord; selectedTabId: string | null };
        expect(blank.isError).not.toBe(true);
        expect(blankPayload.tab.id).not.toBe(openedPayload.tab.id);
        expect(blankPayload.selectedTabId).toBe(blankPayload.tab.id);
        ownedTabIds.add(blankPayload.tab.id);

        // 10-12. Close first (now unselected); selected stays; stale select rejected.
        const closed = await callTool("browser_close_tab", { tabId: openedPayload.tab.id });
        expect(closed.isError).not.toBe(true);
        ownedTabIds.delete(openedPayload.tab.id);
        const stale = await callTool("browser_select_tab", { tabId: openedPayload.tab.id });
        expect(stale.isError).toBe(true);
        expect(JSON.stringify(stale.content)).toContain("BROWSER_TAB_NOT_FOUND");

        // 13-17. External actor via production RPC, outside engine state:
        // open directly through the bridge runtime (engine untouched).
        const extOpened = (await engineRuntime.request("tabs.open", {
          url: "https://example.com/",
        })) as { tab: TabRecord };
        ownedTabIds.add(extOpened.tab.id);
        expect(epochOf(extOpened.tab.id)).toBe(startEpoch);
        const statusAfterExternalOpen = structuredTabs(await callTool("browser_list_tabs"));
        expect(statusAfterExternalOpen.selectedTabId).toBe(blankPayload.tab.id);
        // Engine discovers the externally created tab on list.
        expect(statusAfterExternalOpen.tabs.map((tab) => tab.id)).toContain(extOpened.tab.id);
        await callTool("browser_select_tab", { tabId: extOpened.tab.id });
        // Close externally; engine reconciles disappearance + clears selection.
        await engineRuntime.request("tabs.close", { tabId: extOpened.tab.id });
        ownedTabIds.delete(extOpened.tab.id);
        const reconciled = structuredTabs(await callTool("browser_list_tabs"));
        expect(reconciled.tabs.map((tab) => tab.id)).not.toContain(extOpened.tab.id);
        expect(reconciled.selectedTabId).toBeNull();

        // 13-14. Close selected; selection becomes null.
        await callTool("browser_close_tab", { tabId: blankPayload.tab.id });
        ownedTabIds.delete(blankPayload.tab.id);
        const statusAfterClose = await testClient.callTool({ name: "browser_status", arguments: {} });
        expect(statusAfterClose.structuredContent).toMatchObject({ selectedTabId: null });

        // 18. Every pre-existing user tab still present; test tabs gone.
        // Same single epoch across the whole run (no retargeting).
        const after = structuredTabs(await callTool("browser_list_tabs"));
        for (const id of preexisting) {
          expect(after.tabs.map((tab) => tab.id)).toContain(id);
        }
        expect(after.tabs.map((tab) => tab.id)).not.toContain(openedPayload.tab.id);
        expect(after.tabs.map((tab) => tab.id)).not.toContain(blankPayload.tab.id);
        expectEpochFormat(after.tabs.map((tab) => tab.id));
        expect([...new Set(after.tabs.map((tab) => epochOf(tab.id)))].every((epoch) => epoch === startEpoch)).toBe(true);
      } finally {
        await engine.disconnect();
      }
      expect((await engine.status()).connected).toBe(false);
    },
    BOUND_MS,
  );
});
