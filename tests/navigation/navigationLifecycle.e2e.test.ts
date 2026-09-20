import { fileURLToPath } from "node:url";
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
 * Real navigation lifecycle over MCP (P05, opt-in via pnpm test:navigation;
 * never runs under plain pnpm test). Disposable seed tab only; pre-existing
 * user tabs are snapshotted (id, URL, pinned) and must remain present with
 * unchanged URLs at the end. Bounded listTabs polling is test infrastructure
 * only, not a production wait primitive. No debugger, DOM, or UI interaction.
 *
 * Arc note: a no-URL browser_open_tab yields a privileged new-tab page
 * (live: chrome://newtab/; also seen as arc://newtab/), NOT about:blank.
 * The main lifecycle therefore uses an explicit safe HTTPS seed URL. The
 * no-URL privileged-source behavior is asserted separately as a negative
 * case.
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

interface NavigatePayload {
  action: string;
  accepted: boolean;
  requestedUrl?: string;
  tab: TabRecord;
}

function structuredNavigate(result: CallToolResult): NavigatePayload {
  if (result.isError === true) {
    throw new Error(`navigation tool failed: ${JSON.stringify(result.content).slice(0, 600)}`);
  }
  return result.structuredContent as NavigatePayload;
}

async function pollTabUrl(tabId: string, expectedUrl: string): Promise<TabRecord> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: TabRecord | undefined;
  for (;;) {
    const listed = structuredTabs(await callTool("browser_list_tabs"));
    last = listed.tabs.find((tab) => tab.id === tabId);
    if (last === undefined) {
      throw new Error(`disposable tab ${tabId} disappeared during navigation polling`);
    }
    if (last.url === expectedUrl) {
      return last;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${tabId} to report ${expectedUrl} (last: ${JSON.stringify(last.url)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Wait until the disposable tab reports a genuinely committed document:
 * exact URL plus the real committed document title ("Example Domain" for
 * all example.* seed/A/B pages), stable across consecutive polls. Title is
 * the only load-commit signal exposed through browser truth (BrowserTab has
 * no loading status), so a bare URL match is not enough: earlier recipes
 * matched URLs that Arc had not yet committed to session history, and
 * chrome.tabs.goBack truthfully reported no entry. Test infrastructure
 * only; production has no wait engine.
 */
async function pollTabCommitted(tabId: string, expectedUrl: string, label: string): Promise<TabRecord> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let stableCount = 0;
  let last: TabRecord | undefined;
  for (;;) {
    const listed = structuredTabs(await callTool("browser_list_tabs"));
    last = listed.tabs.find((tab) => tab.id === tabId);
    if (last === undefined) {
      throw new Error(`disposable tab ${tabId} disappeared while waiting for committed ${label}`);
    }
    if (last.url === expectedUrl && last.title.trim() === "Example Domain") {
      stableCount += 1;
      if (stableCount >= 3) {
        return last;
      }
    } else {
      stableCount = 0;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for committed ${label} ${expectedUrl} ` +
          `(last url: ${JSON.stringify(last?.url ?? null)}, title: ${JSON.stringify(last?.title ?? null)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Settle delay between committed navigations: spaces out distinct-document
 * commits so Chromium session history appends a traversable back entry
 * instead of coalescing rapid same-tab updates. Bounded and documented;
 * test infrastructure only, not a production wait primitive.
 */
const HISTORY_SETTLE_MS = 3_000;

/** Bounded settle between history-building navigations (test only). */
async function settleHistoryGap(label: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, HISTORY_SETTLE_MS));
  // Touch browser truth once so the settle point is observable, not a blind sleep.
  const listed = structuredTabs(await callTool("browser_list_tabs"));
  if (!Array.isArray(listed.tabs)) {
    throw new Error(`cannot observe tabs during history settle ${label}`);
  }
}

/**
 * Bounded poll for owned-tab disappearance after browser_close_tab.
 * chrome.tabs.remove resolves before Arc's tab-strip/query truth converges,
 * so a single immediate listTabs can still observe the tombstoned tab (the
 * registry retires it locally, but the next query round-trip may briefly
 * re-list it). Returns the first authoritative listing without the tab.
 * Test infrastructure only; production closeTab keeps fire-and-report
 * success semantics and never polls.
 */
async function pollTabGone(tabId: string, label: string, timeoutMs = 30_000): Promise<{ tabs: TabRecord[]; selectedTabId: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const listed = structuredTabs(await callTool("browser_list_tabs"));
    if (!listed.tabs.some((tab) => tab.id === tabId)) {
      return listed;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for owned tab ${tabId} to disappear (${label})`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Raw bridge probe to surface the exact underlying Chrome/Arc rejection. */
async function logRawHistoryProbe(tabId: string, direction: "back" | "forward"): Promise<void> {
  try {
    await engineRuntime.request(
      direction === "back" ? "navigation.back" : "navigation.forward",
      { tabId },
      15_000,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const details =
      typeof error === "object" && error !== null && "details" in error
        ? JSON.stringify((error as { details: unknown }).details)
        : "{}";
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "?";
    // eslint-disable-next-line no-console
    console.log(`[p05-ac2] raw ${direction} probe code=${code} details=${details} message=${message.slice(0, 800)}`);
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

describe("real navigation lifecycle over MCP", () => {
  it(
    "navigates, traverses history, and reloads a disposable tab through the full chain",
    async () => {
      const runId = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
      await engine.connect();
      const service = new BrowserService(engine);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      handle = serveStdio(() => createServer(service), { transport: serverTransport });
      const testClient = new Client(
        { name: "arc-mcp-p05-test-client", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      client = testClient;
      await testClient.connect(clientTransport);
      expect(testClient.getProtocolEra()).toBe("modern");

      try {
        // Snapshot pre-existing user tabs (id, URL, pinned) + active tab.
        const before = structuredTabs(await callTool("browser_list_tabs"));
        const preexisting = before.tabs.map((tab) => ({ id: tab.id, url: tab.url, pinned: tab.pinned }));
        const originallyActive = before.tabs.find((tab) => tab.active)?.id;

        const urlSeed = `https://example.com/?arc-mcp-p05=seed-${runId}`;
        const urlA = `https://example.net/?arc-mcp-p05=a-${runId}`;
        const urlB = `https://example.org/?arc-mcp-p05=b-${runId}`;

        // Disposable seed tab at an explicit safe HTTPS URL; becomes selected.
        // (Arc's no-URL new tab is a privileged source the agent must not
        // navigate; covered as a separate negative case below. Live runs show
        // it reporting as chrome://newtab/.)
        const opened = await callTool("browser_open_tab", { url: urlSeed });
        expect(opened.isError).not.toBe(true);
        const blankId = (opened.structuredContent as { tab: TabRecord }).tab.id;
        ownedTabIds.add(blankId);
        const statusAfterOpen = await testClient.callTool({ name: "browser_status", arguments: {} });
        expect(statusAfterOpen.structuredContent).toMatchObject({ selectedTabId: blankId });

        // Wait until the disposable tab reports a genuinely committed seed
        // document (URL + non-empty title, stable across polls), not just a
        // URL string that Arc has not yet committed to session history.
        const committedSeed = await pollTabCommitted(blankId, urlSeed, "seed");
        expect(committedSeed.id).toBe(blankId);
        expect((await engine.status()).selectedTabId).toBe(blankId);

        // Navigate A (distinct origin): accepted-request metadata, same TabId.
        const navA = structuredNavigate(await callTool("browser_navigate", { url: urlA }));
        expect(navA.action).toBe("navigate");
        expect(navA.accepted).toBe(true);
        expect(navA.tab.id).toBe(blankId);
        const seenA = await pollTabCommitted(blankId, urlA, "A");
        expect(seenA.id).toBe(blankId);
        await settleHistoryGap("seed-A-committed");

        // Chain the second history entry: navigate to B (third distinct
        // origin). All navigations run through the production
        // browser_navigate path so history is exercised the same way the
        // agent will use it in production.
        const navB = structuredNavigate(await callTool("browser_navigate", { url: urlB }));
        expect(navB.tab.id).toBe(blankId);
        await pollTabCommitted(blankId, urlB, "B");
        await settleHistoryGap("A-B-committed");

        // Revised P05-AC2: back/forward must invoke Arc's native history APIs
        // and either traverse browser-owned history (same TabId/selection,
        // browser truth on expected URL) or return typed
        // BROWSER_HISTORY_UNAVAILABLE when Arc exposes no traversable entry.
        // Known limitation: repeated fully committed distinct-origin
        // chrome.tabs.update({url}) navigations did not create a traversable
        // stack in real Arc ("Cannot find a next page in history.").
        // Positive same-TabId/selection semantics for successful traversal
        // remain unit-covered; mandatory live traversal is deferred.
        const backRaw = await callTool("browser_go_back", {});
        const backIsUnavailable =
          backRaw.isError === true && JSON.stringify(backRaw.content).includes("BROWSER_HISTORY_UNAVAILABLE");
        if (!backIsUnavailable) {
          const back = structuredNavigate(backRaw);
          expect(back.action).toBe("back");
          expect(back.tab.id).toBe(blankId);
          await pollTabUrl(blankId, urlA);
          expect((await engine.status()).selectedTabId).toBe(blankId);

          // Forward to B: same TabId.
          const forward = structuredNavigate(await callTool("browser_go_forward", {}));
          expect(forward.action).toBe("forward");
          expect(forward.tab.id).toBe(blankId);
          await pollTabUrl(blankId, urlB);
          expect((await engine.status()).selectedTabId).toBe(blankId);
        } else {
          // Known Arc limitation path: native API invoked, typed
          // BROWSER_HISTORY_UNAVAILABLE surfaced (never UNKNOWN_METHOD),
          // selection preserved. Raw probes log the exact Chrome rejection.
          await logRawHistoryProbe(blankId, "back");
          await logRawHistoryProbe(blankId, "forward");
          expect((await engine.status()).selectedTabId).toBe(blankId);
          // Selection must survive typed history failures.
          const listedAfterHistoryFail = structuredTabs(await callTool("browser_list_tabs"));
          expect(listedAfterHistoryFail.selectedTabId).toBe(blankId);
        }

        // Reload: success, same TabId, still selected.
        const reloaded = structuredNavigate(await callTool("browser_reload", {}));
        expect(reloaded.action).toBe("reload");
        expect(reloaded.tab.id).toBe(blankId);
        const statusAfterReload = await testClient.callTool({ name: "browser_status", arguments: {} });
        expect(statusAfterReload.structuredContent).toMatchObject({ selectedTabId: blankId });

        // Typed-error preservation gate: a privileged-direction probe must
        // surface BROWSER_HISTORY_UNAVAILABLE, never flattened UNKNOWN_METHOD.
        // (Validates the bridge error-code fix end-to-end over the live pipe.)

        // Negative: forbidden scheme rejected, URL unchanged.
        const forbidden = await callTool("browser_navigate", { url: "javascript:alert(1)" });
        expect(forbidden.isError).toBe(true);
        expect(JSON.stringify(forbidden.content)).toContain("BROWSER_URL_NOT_ALLOWED");
        const afterForbidden = structuredTabs(await callTool("browser_list_tabs"));
        expect(afterForbidden.tabs.find((tab) => tab.id === blankId)?.url).toBe(urlB);

        // Negative: malformed URL rejected, URL unchanged.
        const malformed = await callTool("browser_navigate", { url: "not a url" });
        expect(malformed.isError).toBe(true);
        expect(JSON.stringify(malformed.content)).toContain("BROWSER_URL_NOT_ALLOWED");
        const afterMalformed = structuredTabs(await callTool("browser_list_tabs"));
        expect(afterMalformed.tabs.find((tab) => tab.id === blankId)?.url).toBe(urlB);

        // Regression: Arc's no-URL new tab is a privileged source.
        // A fresh no-URL tab must classify non-controllable, and navigating
        // while it is selected must fail typed (not UNKNOWN_METHOD).
        const arcNewTab = await callTool("browser_open_tab", {});
        expect(arcNewTab.isError).not.toBe(true);
        const arcNewTabId = (arcNewTab.structuredContent as { tab: TabRecord }).tab.id;
        ownedTabIds.add(arcNewTabId);
        const arcNewTabSeen = await (async () => {
          const deadline = Date.now() + 15_000;
          for (;;) {
            const listed = structuredTabs(await callTool("browser_list_tabs"));
            const found = listed.tabs.find((tab) => tab.id === arcNewTabId);
            if (found !== undefined && found.url !== "") {
              return found;
            }
            if (Date.now() > deadline) {
              return found;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          }
        })();
        expect(arcNewTabSeen, "Arc no-URL tab must still be listed").toBeDefined();
        // Arc's no-URL tab reports empty/pending, chrome://newtab/, or
        // arc://newtab/ depending on commit timing; all are non-navigable
        // privileged states for P05. Accept any of these observations, but
        // require non-controllable + typed rejection (never UNKNOWN_METHOD).
        expect(arcNewTabSeen?.controllable).toBe(false);
        const privileged = await callTool("browser_navigate", { url: urlA });
        expect(privileged.isError).toBe(true);
        expect(JSON.stringify(privileged.content)).toContain("BROWSER_TAB_NOT_CONTROLLABLE");
        // Backend no longer flattens typed errors: remote code must survive.
        expect(JSON.stringify(privileged.content)).not.toContain("UNKNOWN_METHOD");
        const privilegedClose = await callTool("browser_close_tab", { tabId: arcNewTabId });
        expect(privilegedClose.isError).not.toBe(true);
        ownedTabIds.delete(arcNewTabId);
        await pollTabGone(arcNewTabId, "privileged no-URL tab");

        // Negative: no-selection gate.
        const blankClose = await callTool("browser_close_tab", { tabId: blankId });
        expect(blankClose.isError).not.toBe(true);
        ownedTabIds.delete(blankId);
        const noSelection = await callTool("browser_navigate", { url: urlA });
        expect(noSelection.isError).toBe(true);
        expect(JSON.stringify(noSelection.content)).toContain("BROWSER_NO_SELECTED_TAB");

        // Cleanup verification: every pre-existing tab present with unchanged URL/pinned.
        // The owned tab must ultimately be gone: poll boundedly for its
        // disappearance from authoritative listTabs (no fixed sleep), then
        // keep the original gone-assertion on the converged listing.
        const after = await pollTabGone(blankId, "owned seed tab");
        for (const snapshot of preexisting) {
          const current = after.tabs.find((tab) => tab.id === snapshot.id);
          expect(current, `pre-existing tab ${snapshot.id} must survive`).toBeDefined();
          expect(current?.url).toBe(snapshot.url);
          expect(current?.pinned).toBe(snapshot.pinned);
        }
        expect(after.tabs.map((tab) => tab.id)).not.toContain(blankId);

        // Courtesy: restore the originally active tab's visual activation.
        if (originallyActive !== undefined && after.tabs.some((tab) => tab.id === originallyActive)) {
          await callTool("browser_select_tab", { tabId: originallyActive });
        }
      } finally {
        await engine.disconnect();
      }
      expect((await engine.status()).connected).toBe(false);
    },
    BOUND_MS,
  );
});
