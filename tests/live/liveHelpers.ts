/**
 * Shared helpers for P10 live release/soak/reconnect suites.
 *
 * Every live suite MUST:
 * - use only disposable 127.0.0.1 fixture tabs + no-URL privileged tabs,
 * - record pre-existing tabs first (id/url/pinned/active),
 * - never snapshot/evaluate/click/read/observe a pre-existing tab,
 * - close ONLY owned tabs with bounded polling,
 * - restore the originally active tab and prove survivors unchanged.
 */

import { fileURLToPath } from "node:url";
import * as http from "node:http";
import * as path from "node:path";
import { expect } from "vitest";
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

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXPECTED_ID = loadExtensionIdentity(REPO_ROOT).extensionId;
export const BOUND_MS = 480_000;
export const POLL_TIMEOUT_MS = 90_000;
export const POLL_INTERVAL_MS = 750;

export interface TabRecord {
  id: string;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
  windowId: number;
  controllable: boolean;
}

export interface LiveContext {
  engine: ArcExtensionEngine;
  runtime: BridgeRuntime;
  handle: StdioServerHandle | null;
  client: Client;
  ownedTabIds: Set<string>;
  preexisting: Array<{ id: string; url: string; pinned: boolean }>;
  originallyActive: string | null;
  fixtureServer: http.Server | null;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return client.callTool({ name, arguments: args });
}

export function structuredTabs(result: CallToolResult): { tabs: TabRecord[]; selectedTabId: string | null } {
  expect(result.isError).not.toBe(true);
  const payload = result.structuredContent as { tabs?: TabRecord[]; selectedTabId?: string | null } | undefined;
  expect(Array.isArray(payload?.tabs)).toBe(true);
  return { tabs: payload?.tabs ?? [], selectedTabId: payload?.selectedTabId ?? null };
}

export function toolErrorCode(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const text = JSON.stringify(result.content);
  const match = /"text":"([A-Z0-9_]+):/.exec(text) ?? /([A-Z0-9_]+):/.exec(text);
  return match?.[1] ?? text.slice(0, 80);
}

export async function startLiveSession(testClientName: string): Promise<LiveContext> {
  const runtime = new BridgeRuntime({});
  const engine = new ArcExtensionEngine({
    runtime,
    extensionId: EXPECTED_ID,
    connectTimeoutMs: 180_000,
  });
  await engine.connect();
  const status = await engine.status();
  expect(status.connected).toBe(true);
  const service = new BrowserService(engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createServer(service), { transport: serverTransport });
  const client = new Client(
    { name: testClientName, version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(clientTransport);
  expect(client.getProtocolEra()).toBe("modern");
  const before = structuredTabs(await callTool(client, "browser_list_tabs"));
  return {
    engine,
    runtime,
    handle,
    client,
    ownedTabIds: new Set<string>(),
    preexisting: before.tabs.map((tab) => ({ id: tab.id, url: tab.url, pinned: tab.pinned })),
    originallyActive: before.tabs.find((tab) => tab.active)?.id ?? null,
    fixtureServer: null,
  };
}

export async function pollTabCommitted(ctx: LiveContext, tabId: string, expectedUrl: string): Promise<TabRecord> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let stableCount = 0;
  let last: TabRecord | undefined;
  for (;;) {
    const listed = structuredTabs(await callTool(ctx.client, "browser_list_tabs"));
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

export async function pollOwnedTabsGone(ctx: LiveContext, tabIds: string[]): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const listed = structuredTabs(await callTool(ctx.client, "browser_list_tabs"));
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

export async function openDisposableTab(ctx: LiveContext, url: string): Promise<TabRecord> {
  const opened = await callTool(ctx.client, "browser_open_tab", { url });
  expect(opened.isError).not.toBe(true);
  const tab = (opened.structuredContent as { tab: TabRecord }).tab;
  ctx.ownedTabIds.add(tab.id);
  return pollTabCommitted(ctx, tab.id, url);
}

export function startFixture(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ base: string; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("fixture server has no address"));
        return;
      }
      resolve({ base: `http://127.0.0.1:${String(address.port)}`, server });
    });
  });
}

async function withTimeout(work: () => Promise<unknown>, ms = 10_000): Promise<void> {
  try {
    await Promise.race([work().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, ms))]);
  } catch {
    // Best effort only.
  }
}

/** Close ONLY owned tabs, verify survivors, restore focus, stop infra. */
export async function closeLiveSession(ctx: LiveContext): Promise<{ survivors: number }> {
  const owned = [...ctx.ownedTabIds];
  for (const tabId of owned) {
    await withTimeout(() => ctx.client.callTool({ name: "browser_close_tab", arguments: { tabId } }));
    ctx.ownedTabIds.delete(tabId);
  }
  if (owned.length > 0) {
    await pollOwnedTabsGone(ctx, owned);
  }
  const after = structuredTabs(await callTool(ctx.client, "browser_list_tabs"));
  for (const entry of ctx.preexisting) {
    const current = after.tabs.find((tab) => tab.id === entry.id);
    expect(current, `pre-existing tab ${entry.id} must survive`).toBeDefined();
    expect(current?.url).toBe(entry.url);
    expect(current?.pinned).toBe(entry.pinned);
  }
  if (ctx.originallyActive !== null && after.tabs.some((tab) => tab.id === ctx.originallyActive)) {
    await callTool(ctx.client, "browser_select_tab", { tabId: ctx.originallyActive });
  }
  expect((await ctx.engine.status()).connected).toBe(true);
  const client = ctx.client;
  await withTimeout(() => client.close());
  if (ctx.handle !== null) {
    const handle = ctx.handle;
    ctx.handle = null;
    await withTimeout(() => handle.close());
  }
  await withTimeout(() => ctx.engine.disconnect());
  if (ctx.fixtureServer !== null) {
    const server = ctx.fixtureServer;
    ctx.fixtureServer = null;
    await withTimeout(() => new Promise<void>((resolve) => server.close(() => resolve())));
  }
  return { survivors: ctx.preexisting.length };
}
