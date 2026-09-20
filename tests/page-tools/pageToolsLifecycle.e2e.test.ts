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
 * Real P08 page tools over MCP (opt-in via pnpm test:page-tools; never
 * runs under plain pnpm test). Deterministic disposable fixture served ONLY
 * from 127.0.0.1 on an ephemeral port (test infrastructure only; not a
 * product listener). Pre-existing user tabs are recorded first and must
 * remain present with unchanged URLs/pinned state; the originally active
 * tab is restored. Existing user pages are never evaluated,
 * screenshotted, inspected, or waited against.
 *
 * DO NOT RUN against a stale (pre-P08) extension worker: the prelive gate
 * requires the live buildId to match the reviewer-approved P08 build
 * before this suite runs.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXPECTED_ID = loadExtensionIdentity(REPO_ROOT).extensionId;
const BOUND_MS = 480_000;
const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 750;
const WAIT_SHORT_MS = 3_000;

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
<html lang="en"><head><meta charset="utf-8"><title>P08 Fixture Home</title></head>
<body>
<h1>P08 Fixture</h1>
<div id="status" role="status">status: ready</div>
<div id="delayed" role="status">waiting</div>
<div id="content"><p>Normal visible content for screenshot verification: the quick brown fox jumps over the lazy dog 0123456789.</p><p>Second paragraph with enough text to render a non-trivial viewport capture.</p></div>
<script>
setTimeout(() => { document.getElementById("delayed").textContent = "delayed-token-p08-visible"; }, 1500);
setTimeout(() => { document.title = "P08 Fixture Delayed"; }, 2500);
</script>
</body></html>`;

const NEXT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>P08 Fixture Next</title></head>
<body>
<h1>P08 Fixture Next</h1>
<div id="status" role="status">status: next</div>
</body></html>`;

let fixtureBase = "";
let fixtureServer: http.Server | null = null;

async function startFixture(): Promise<string> {
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
      return;
    }
    if (req.url === "/next") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(NEXT_HTML);
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

function structuredEvaluate(result: CallToolResult, label: string): { kind: string; value?: unknown } {
  if (result.isError === true) {
    throw new Error(`${label} failed: ${JSON.stringify(result.content).slice(0, 800)}`);
  }
  const payload = result.structuredContent as { kind?: unknown; value?: unknown } | undefined;
  expect(typeof payload?.kind).toBe("string");
  return payload as { kind: string; value?: unknown };
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

describe("real P08 page tools over MCP", () => {
  it(
    "evaluate/screenshot/wait_for against a disposable localhost fixture",
    async () => {
      fixtureBase = await startFixture();
      const fixtureUrl = `${fixtureBase}/`;
      const nextUrl = `${fixtureBase}/next`;
      await engine.connect();
      const status = await engine.status();
      expect(status.connected).toBe(true);
      const service = new BrowserService(engine);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      handle = serveStdio(() => createServer(service), { transport: serverTransport });
      const testClient = new Client(
        { name: "arc-mcp-p08-test-client", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      client = testClient;
      await testClient.connect(clientTransport);

      const tools = (await testClient.listTools()).tools.map((tool) => tool.name);
      for (const name of ["browser_evaluate", "browser_screenshot", "browser_wait_for"]) {
        expect(tools).toContain(name);
      }

      // Bridge-traffic spy (test-only): proves privileged rejections happen
      // before any runtime.evaluate / page.screenshot / wait.check traffic.
      // Engine gates controllability via listTabs before any such request.
      const bridgeTraffic = { evaluate: 0, screenshot: 0, waitCheck: 0 };
      if (runtimeRequestBaseline === null) {
        runtimeRequestBaseline = engineRuntime.request.bind(engineRuntime);
      }
      const originalRuntimeRequest = runtimeRequestBaseline;
      engineRuntime.request = async (
        method: Parameters<BridgeRuntime["request"]>[0],
        payload?: Parameters<BridgeRuntime["request"]>[1],
        timeoutMs?: Parameters<BridgeRuntime["request"]>[2],
      ) => {
        if (method === "runtime.evaluate") {
          bridgeTraffic.evaluate += 1;
        } else if (method === "page.screenshot") {
          bridgeTraffic.screenshot += 1;
        } else if (method === "wait.check") {
          bridgeTraffic.waitCheck += 1;
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

      // ---- EVALUATE: by-value + unicode + promise + throw + stale refs.
      let snapshot = structuredSnapshot(await callTool("browser_snapshot", {}));
      expect(snapshot.tabId).toBe(openedTab.id);
      const preEvalRef = headingRef(snapshot);

      const simple = structuredEvaluate(await callTool("browser_evaluate", { expression: "40 + 2" }), "evaluate");
      expect(simple.kind).toBe("json");
      expect(simple.value).toBe(42);

      const unicode = structuredEvaluate(
        await callTool("browser_evaluate", { expression: "'héllo 世界🙂'" }),
        "unicode evaluate",
      );
      expect(unicode).toEqual({ kind: "json", value: "héllo 世界🙂" });

      const promised = structuredEvaluate(
        await callTool("browser_evaluate", { expression: "new Promise((resolve) => setTimeout(() => resolve(7 * 6), 50))" }),
        "promise evaluate",
      );
      expect(promised).toEqual({ kind: "json", value: 42 });

      const throwing = await callTool("browser_evaluate", { expression: "throw new Error('p08-fixture-boom')" });
      expect(toolErrorCode(throwing)).toBe("BROWSER_EVALUATION_FAILED");
      expect(JSON.stringify(throwing.content)).not.toContain("p08-fixture-boom");

      // Dispatched evaluation invalidates refs (even the throwing one did).
      const staleProbe = await callTool("browser_get_text", { ref: preEvalRef });
      expect(toolErrorCode(staleProbe)).toBe("BROWSER_STALE_ELEMENT");

      // ---- EVALUATE TIMEOUT RECOVERY: never-settling promise, short valid
      // timeout, bounded wall-clock, immediate reattach success.
      const timeoutMs = 1_000;
      const timeoutStartedAt = Date.now();
      const hanging = await callTool("browser_evaluate", {
        expression: "new Promise(() => {})",
        timeoutMs,
      });
      const timeoutElapsedMs = Date.now() - timeoutStartedAt;
      expect(toolErrorCode(hanging)).toBe("BROWSER_EVALUATION_TIMEOUT");
      expect(JSON.stringify(hanging.content)).not.toContain("new Promise");
      // Bounded wall-clock: timeout + retirement detach (3000ms bound) +
      // bridge margin + slack; must never hang toward BOUND_MS.
      expect(timeoutElapsedMs).toBeLessThan(30_000);
      // Immediate recovery: debugger reattachment succeeds after retirement.
      const recovered = structuredEvaluate(
        await callTool("browser_evaluate", { expression: "2 + 2" }),
        "recovery evaluate",
      );
      expect(recovered).toEqual({ kind: "json", value: 4 });
      expect((await engine.status()).connected).toBe(true);

      // ---- SCREENSHOT: valid PNG, read-only (ref stays live).
      snapshot = structuredSnapshot(await callTool("browser_snapshot", {}));
      const shotRef = headingRef(snapshot);
      const shot = await callTool("browser_screenshot", {});
      expect(shot.isError).not.toBe(true);
      const image = (shot.content as Array<{ type?: string; data?: string; mimeType?: string }>).find(
        (entry) => entry.type === "image",
      );
      expect(image?.mimeType).toBe("image/png");
      expect(typeof image?.data).toBe("string");
      expect((image?.data ?? "").length).toBeGreaterThan(0);
      const decoded = Buffer.from(image?.data ?? "", "base64");
      expect([...decoded.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(decoded.length).toBeGreaterThan(1_024);
      expect(decoded.length).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect((shot.structuredContent as { mimeType?: string } | undefined)?.mimeType).toBe("image/png");
      // Same ref still works: screenshot did not rotate/invalidate refs.
      const afterShot = await callTool("browser_get_text", { ref: shotRef });
      expect(afterShot.isError).not.toBe(true);
      expect(JSON.stringify(afterShot.structuredContent)).toContain("P08 Fixture");

      // ---- WAIT-REF PRESERVATION (stable document, no navigation):
      // snapshot, retain heading ref, successful load/text/title waits must
      // not rotate/invalidate refs: SAME ref still reads afterwards.
      snapshot = structuredSnapshot(await callTool("browser_snapshot", {}));
      const waitPreservedRef = headingRef(snapshot);
      const stableLoadWait = await callTool("browser_wait_for", {
        condition: { type: "load" },
        timeoutMs: 15_000,
      });
      expect(stableLoadWait.isError).not.toBe(true);
      expect(stableLoadWait.structuredContent).toMatchObject({ matched: true, condition: "load" });
      const stableTextWait = await callTool("browser_wait_for", {
        condition: { type: "text", value: "P08 Fixture" },
        timeoutMs: 15_000,
      });
      expect(stableTextWait.isError).not.toBe(true);
      expect(stableTextWait.structuredContent).toMatchObject({ matched: true, condition: "text" });
      const waitPreserved = await callTool("browser_get_text", { ref: waitPreservedRef });
      expect(waitPreserved.isError, "wait must preserve live refs on a stable document").not.toBe(true);
      expect(JSON.stringify(waitPreserved.structuredContent)).toContain("P08 Fixture");

      // ---- WAIT: load, text (delayed), title (delayed), url (same-tab nav), timeout.
      const loadWait = await callTool("browser_wait_for", {
        condition: { type: "load" },
        timeoutMs: 15_000,
      });
      expect(loadWait.isError).not.toBe(true);
      expect(loadWait.structuredContent).toMatchObject({ matched: true, condition: "load" });

      const textWait = await callTool("browser_wait_for", {
        condition: { type: "text", value: "delayed-token-p08-visible" },
        timeoutMs: 30_000,
      });
      expect(textWait.isError).not.toBe(true);
      expect(textWait.structuredContent).toMatchObject({ matched: true, condition: "text" });

      const titleWait = await callTool("browser_wait_for", {
        condition: { type: "title", match: "equals", value: "P08 Fixture Delayed" },
        timeoutMs: 30_000,
      });
      expect(titleWait.isError).not.toBe(true);
      expect(titleWait.structuredContent).toMatchObject({ matched: true, condition: "title" });

      const nav = await callTool("browser_navigate", { url: nextUrl });
      expect(nav.isError).not.toBe(true);
      const urlWait = await callTool("browser_wait_for", {
        condition: { type: "url", match: "equals", value: nextUrl },
        timeoutMs: 30_000,
      });
      expect(urlWait.isError).not.toBe(true);
      expect(urlWait.structuredContent).toMatchObject({ matched: true, condition: "url" });
      expect((await engine.status()).selectedTabId).toBe(openedTab.id);

      const impossible = await callTool("browser_wait_for", {
        condition: { type: "text", value: "p08-impossible-token-zzz-999" },
        timeoutMs: WAIT_SHORT_MS,
      });
      expect(toolErrorCode(impossible)).toBe("BROWSER_WAIT_TIMEOUT");

      // ---- Privileged negatives on a DETERMINISTIC disposable new-tab page
      // owned by the test (P04/P05/P06 precedent: no-URL open yields a
      // privileged chrome://newtab/ source). No pre-existing user tab is
      // touched; the privileged page contents are never inspected.
      const privilegedOpen = await callTool("browser_open_tab", {});
      expect(privilegedOpen.isError).not.toBe(true);
      const privilegedTab = (privilegedOpen.structuredContent as { tab: TabRecord }).tab;
      ownedTabIds.add(privilegedTab.id);
      // The new tab becomes selected on open; require non-controllable
      // classification through authoritative list truth (never inspect it).
      // New-tab commit timing varies: the record may arrive as a pending
      // empty-url (""/about:blank, NOT controllable) or as a committed
      // chrome://newtab/ (privileged, NOT controllable). Either way the
      // engine must fail the privileged trio before any debugger traffic.
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
      // Live contract: the selected disposable tab is NOT controllable. The
      // new-tab URL may read chrome://newtab/ (privileged) or a pending
      // empty/about:blank at poll time; the product promise is only that the
      // engine's authoritative gate rejects this tab for page-tool control.
      // BROWSER_TAB_NOT_CONTROLLABLE below is the real required signal.
      // eslint-disable-next-line no-console
      console.log(
        `[p08-ac4] privileged seen url=${JSON.stringify(privilegedSeen?.url ?? null)} controllable=${String(privilegedSeen?.controllable ?? null)}`,
      );
      if (privilegedSeen?.url !== undefined && /^https?:/i.test(privilegedSeen.url)) {
        throw new Error(`disposable privileged tab unexpectedly controllable: ${JSON.stringify(privilegedSeen.url)}`);
      }
      const evaluateTrafficBefore = { ...bridgeTraffic };
      const privilegedEvaluate = await callTool("browser_evaluate", { expression: "1" });
      expect(toolErrorCode(privilegedEvaluate)).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
      const privilegedShot = await callTool("browser_screenshot", {});
      expect(toolErrorCode(privilegedShot)).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
      const privilegedWait = await callTool("browser_wait_for", {
        // wait.check against the privileged tab goes through the page-tools
        // engine path: Node-side requireSelectedTab fails TAB_NOT_CONTROLLABLE
        // here too, so zero wait.check traffic is expected.
        condition: { type: "text", value: "privileged-unobservable-token-zzz" },
        timeoutMs: 2_000,
      });
      expect(toolErrorCode(privilegedWait)).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
      // Rejection happened before any production debugger/semantic traffic.
      expect(bridgeTraffic.evaluate).toBe(evaluateTrafficBefore.evaluate);
      expect(bridgeTraffic.screenshot).toBe(evaluateTrafficBefore.screenshot);
      expect(bridgeTraffic.waitCheck).toBe(evaluateTrafficBefore.waitCheck);
      // Restore the fixture tab, then convergently close the disposable
      // privileged tab (bounded: poll until gone from authoritative truth).
      await callTool("browser_select_tab", { tabId: openedTab.id });
      const privilegedClose = await callTool("browser_close_tab", { tabId: privilegedTab.id });
      expect(privilegedClose.isError).not.toBe(true);
      ownedTabIds.delete(privilegedTab.id);
      await pollOwnedTabsGone([privilegedTab.id]);
      expect((await engine.status()).selectedTabId).toBe(openedTab.id);

      // ---- Cleanup: only owned tabs; user tabs untouched; focus restored.
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
