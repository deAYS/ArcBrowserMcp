import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import type { BridgeTransportMethod } from "../src/browser/extension/BridgeRuntime.js";
import { BridgeRuntime } from "../src/browser/extension/BridgeRuntime.js";
import { ArcExtensionEngine } from "../src/browser/extension/ArcExtensionEngine.js";
import { BrowserService } from "../src/browser/BrowserService.js";
import { ArcError } from "../src/errors/ArcError.js";
import type { BrowserTab } from "../src/browser/models.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const TAB_A = `t-${"a".repeat(32)}-11`;
const TAB_B = `t-${"b".repeat(32)}-22`;

function makeRecord(id: string, overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id,
    title: overrides.title ?? `Tab ${id}`,
    url: overrides.url ?? "https://example.com/",
    active: overrides.active ?? false,
    pinned: false,
    windowId: 1,
    controllable: overrides.controllable ?? true,
    ...overrides,
  };
}

class FakeNavigationRuntime extends BridgeRuntime {
  relayConnected = true;
  requests: Array<{ method: string; payload: Record<string, unknown> }> = [];
  failNext: BridgeError | null = null;
  tabs = new Map<string, BrowserTab>([
    [TAB_A, makeRecord(TAB_A, { title: "User Tab", active: true })],
    [TAB_B, makeRecord(TAB_B, { title: "Other" })],
  ]);

  constructor() {
    super({ pipeName: "\\\\.\\pipe\\arc-mcp-fake-nav", sessionDir: "C:\\arc-mcp-fake-nav" });
  }

  override async start(): Promise<void> {
    // No-op.
  }

  override async stop(): Promise<void> {
    // No-op.
  }

  override isRelayConnected(): boolean {
    return this.relayConnected;
  }

  override onRelayChange(): () => void {
    return () => undefined;
  }

  override async request(
    method: BridgeTransportMethod,
    payload: Record<string, unknown> = {},
  ): Promise<unknown> {
    this.requests.push({ method, payload });
    if (this.failNext !== null) {
      const failure = this.failNext;
      this.failNext = null;
      throw failure;
    }
    if (!this.relayConnected) {
      throw new BridgeError("NOT_CONNECTED", "no relay");
    }
    if (method === "tabs.list") {
      return { tabs: [...this.tabs.values()] };
    }
    if (method === "tabs.activate" || method === "tabs.close") {
      const tabId = payload["tabId"];
      if (typeof tabId !== "string" || !this.tabs.has(tabId)) {
        throw new BridgeError("INVALID_ENVELOPE", "remote says gone", { remoteCode: "TAB_NOT_FOUND" });
      }
      if (method === "tabs.activate") {
        const found = this.tabs.get(tabId);
        if (found === undefined) {
          throw new BridgeError("INVALID_ENVELOPE", "gone");
        }
        return { tab: { ...found, active: true } };
      }
      this.tabs.delete(tabId);
      return { closed: tabId };
    }
    if (method === "tabs.open") {
      const created = makeRecord(`t-${"c".repeat(32)}-99`, {
        title: "New Tab",
        url: typeof payload["url"] === "string" ? payload["url"] : "",
        active: true,
      });
      this.tabs.set(created.id, created);
      return { tab: created };
    }
    if (
      method === "navigation.navigate" ||
      method === "navigation.back" ||
      method === "navigation.forward" ||
      method === "navigation.reload"
    ) {
      const tabId = payload["tabId"];
      if (typeof tabId !== "string" || !this.tabs.has(tabId)) {
        throw new BridgeError("INVALID_ENVELOPE", "remote says gone", { remoteCode: "TAB_NOT_FOUND" });
      }
      const current = this.tabs.get(tabId);
      if (current === undefined) {
        throw new BridgeError("INVALID_ENVELOPE", "gone");
      }
      if (method === "navigation.navigate") {
        const url = payload["url"];
        if (typeof url !== "string") {
          throw new BridgeError("INVALID_ENVELOPE", "missing url");
        }
        if (url.startsWith("rejected://")) {
          throw new BridgeError("INVALID_ENVELOPE", "rejected", { remoteCode: "TAB_URL_NOT_ALLOWED" });
        }
        if (url.startsWith("privileged://")) {
          throw new BridgeError("INVALID_ENVELOPE", "privileged source", { remoteCode: "TAB_NOT_CONTROLLABLE" });
        }
        if (url.startsWith("explode://")) {
          throw new BridgeError("INVALID_ENVELOPE", "chrome blew up");
        }
        const updated = { ...current, url };
        this.tabs.set(tabId, updated);
        return { tab: updated, requestedUrl: url };
      }
      if (method === "navigation.back" || method === "navigation.forward") {
        const direction = method === "navigation.back" ? "back" : "forward";
        if (payload["noHistory"] === true) {
          throw new BridgeError("INVALID_ENVELOPE", "empty", { remoteCode: "TAB_HISTORY_UNAVAILABLE" });
        }
        const updated = { ...current, url: `https://example.com/${direction}` };
        this.tabs.set(tabId, updated);
        return { tab: updated };
      }
      return { tab: { ...current } };
    }
    if (method === "bridge.status" || method === "bridge.ping" || method === "bridge.hello") {
      return { connected: true };
    }
    throw new BridgeError("INVALID_ENVELOPE", `unexpected method ${method}`);
  }
}

function engineWith(): { engine: ArcExtensionEngine; runtime: FakeNavigationRuntime } {
  const runtime = new FakeNavigationRuntime();
  const engine = new ArcExtensionEngine({
    runtime,
    extensionId: EXTENSION_ID,
    connectTimeoutMs: 2_000,
    checkPrerequisites: () => Promise.resolve([]),
  });
  return { engine, runtime };
}

async function connectedEngine(): Promise<{ engine: ArcExtensionEngine; runtime: FakeNavigationRuntime }> {
  const harness = engineWith();
  await harness.engine.connect();
  return harness;
}

async function catchCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ArcError);
    return (error as ArcError).code;
  }
  throw new Error("expected action to throw");
}

describe("engine navigation selection gating", () => {
  it("navigate requires a selected tab and sends no bridge traffic without one", async () => {
    const { engine, runtime } = await connectedEngine();
    expect((await engine.status()).selectedTabId).toBeNull();
    const before = runtime.requests.length;
    expect(await catchCode(() => engine.navigate({ url: "https://example.com/" }))).toBe("BROWSER_NO_SELECTED_TAB");
    expect(runtime.requests.length).toBe(before);
  });

  it("stale selection clears to null and fails without fallback", async () => {
    const { engine, runtime } = await connectedEngine();
    await engine.selectTab(TAB_A);
    runtime.tabs.delete(TAB_A);
    // Any engine call reconciles through list: navigation fails typed, status heals.
    expect(await catchCode(() => engine.navigate({ url: "https://example.com/" }))).toBe("BROWSER_TAB_NOT_FOUND");
    expect((await engine.status()).selectedTabId).toBeNull();
  });

  it("goBack/goForward/reload require selection too", async () => {
    const { engine } = await connectedEngine();
    expect(await catchCode(() => engine.goBack())).toBe("BROWSER_NO_SELECTED_TAB");
    expect(await catchCode(() => engine.goForward())).toBe("BROWSER_NO_SELECTED_TAB");
    expect(await catchCode(() => engine.reload())).toBe("BROWSER_NO_SELECTED_TAB");
  });
});

describe("engine navigation URL policy", () => {
  it("accepts http/https/localhost URLs and preserves identity", async () => {
    const { engine, runtime } = await connectedEngine();
    await engine.selectTab(TAB_A);
    for (const url of ["https://example.com/", "http://localhost:3000/", "http://127.0.0.1/x"]) {
      const result = await engine.navigate({ url });
      expect(result.action).toBe("navigate");
      expect(result.accepted).toBe(true);
      expect(result.tab.id).toBe(TAB_A);
      expect(result.tab.url).toBe(url);
      expect((await engine.status()).selectedTabId).toBe(TAB_A);
    }
    expect(runtime.requests.filter((request) => request.method === "navigation.navigate")).toHaveLength(3);
  });

  it("rejects forbidden schemes, malformed input, and credentials before RPC", async () => {
    const { engine, runtime } = await connectedEngine();
    await engine.selectTab(TAB_A);
    const before = runtime.requests.filter((request) => request.method === "navigation.navigate").length;
    const cases: Array<[string, string]> = [
      ["javascript:alert(1)", "BROWSER_URL_NOT_ALLOWED"],
      ["JAVASCRIPT:alert(1)", "BROWSER_URL_NOT_ALLOWED"],
      ["data:text/html,x", "BROWSER_URL_NOT_ALLOWED"],
      ["file:///etc/passwd", "BROWSER_URL_NOT_ALLOWED"],
      ["chrome://settings", "BROWSER_URL_NOT_ALLOWED"],
      ["chrome-extension://abc", "BROWSER_URL_NOT_ALLOWED"],
      ["arc://extensions", "BROWSER_URL_NOT_ALLOWED"],
      ["devtools://devtools/x", "BROWSER_URL_NOT_ALLOWED"],
      ["view-source:https://example.com/", "BROWSER_URL_NOT_ALLOWED"],
      ["not a url", "BROWSER_URL_NOT_ALLOWED"],
      ["https://user:pw@example.com/", "BROWSER_URL_NOT_ALLOWED"],
      ["https://example.com/\u0000", "BROWSER_URL_NOT_ALLOWED"],
    ];
    for (const [url, code] of cases) {
      expect(await catchCode(() => engine.navigate({ url }))).toBe(code);
    }
    const after = runtime.requests.filter((request) => request.method === "navigation.navigate").length;
    expect(after).toBe(before);
    // Tab URL untouched by any rejected attempt.
    const tabs = await engine.listTabs();
    expect(tabs.find((tab) => tab.id === TAB_A)?.url).toBe("https://example.com/");
  });

  it("maps extension-boundary rejections to project errors", async () => {
    const { engine } = await connectedEngine();
    await engine.selectTab(TAB_A);
    const runtime = (engine as unknown as { options: { runtime: FakeNavigationRuntime } }).options.runtime;
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "bad", { remoteCode: "TAB_URL_NOT_ALLOWED" });
    expect(await catchCode(() => engine.goBack())).toBe("BROWSER_NAVIGATION_FAILED");
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "priv", { remoteCode: "TAB_NOT_CONTROLLABLE" });
    expect(await catchCode(() => engine.reload())).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "gone", { remoteCode: "TAB_NOT_FOUND" });
    expect(await catchCode(() => engine.goForward())).toBe("BROWSER_TAB_NOT_FOUND");
    expect((await engine.status()).selectedTabId).toBeNull();
  });
});

describe("engine history and reload", () => {
  it("back/forward/reload preserve TabId and selection", async () => {
    const { engine } = await connectedEngine();
    await engine.selectTab(TAB_A);
    await engine.goBack();
    expect((await engine.status()).selectedTabId).toBe(TAB_A);
    const backTabs = await engine.listTabs();
    expect(backTabs.find((tab) => tab.id === TAB_A)?.url).toBe("https://example.com/back");
    await engine.goForward();
    expect((await engine.status()).selectedTabId).toBe(TAB_A);
    const forwardTabs = await engine.listTabs();
    expect(forwardTabs.find((tab) => tab.id === TAB_A)?.url).toBe("https://example.com/forward");
    await engine.reload();
    expect((await engine.status()).selectedTabId).toBe(TAB_A);
    await engine.reload(true);
    expect((await engine.status()).selectedTabId).toBe(TAB_A);
  });

  it("unavailable history maps to typed errors without clearing selection", async () => {
    const { engine, runtime } = await connectedEngine();
    await engine.selectTab(TAB_A);
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "empty", { remoteCode: "TAB_HISTORY_UNAVAILABLE" });
    expect(await catchCode(() => engine.goBack())).toBe("BROWSER_HISTORY_UNAVAILABLE");
    expect((await engine.status()).selectedTabId).toBe(TAB_A);
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "empty", { remoteCode: "TAB_HISTORY_UNAVAILABLE" });
    expect(await catchCode(() => engine.goForward())).toBe("BROWSER_HISTORY_UNAVAILABLE");
    expect((await engine.status()).selectedTabId).toBe(TAB_A);
  });

  it("chrome navigation failure maps to BROWSER_NAVIGATION_FAILED", async () => {
    const { engine, runtime } = await connectedEngine();
    await engine.selectTab(TAB_A);
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "chrome blew up");
    expect(await catchCode(() => engine.goBack())).toBe("BROWSER_NAVIGATION_FAILED");
  });

  it("effective/pending URL behavior comes from browser truth on next list", async () => {
    const { engine, runtime } = await connectedEngine();
    await engine.selectTab(TAB_A);
    const result = await engine.navigate({ url: "https://example.com/?x=1" });
    expect(result.tab.url).toBe("https://example.com/?x=1");
    // Simulate the browser truth updating asynchronously (redirect landing).
    runtime.tabs.set(TAB_A, makeRecord(TAB_A, { url: "https://example.com/landed" }));
    const reconciled = await engine.listTabs();
    expect(reconciled.find((tab) => tab.id === TAB_A)?.url).toBe("https://example.com/landed");
    expect(reconciled.find((tab) => tab.id === TAB_A)?.id).toBe(TAB_A);
  });
});

describe("BrowserService navigation delegation", () => {
  it("delegates navigate/back/forward/reload and reports not-implemented without an engine", async () => {
    const { engine } = await connectedEngine();
    const service = new BrowserService(engine);
    await service.selectTab(TAB_A);
    const navigated = await service.navigate("https://example.com/n");
    expect(navigated.action).toBe("navigate");
    expect(navigated.tab.id).toBe(TAB_A);
    const back = await service.goBack();
    expect(back.action).toBe("back");
    expect(back.tab.id).toBe(TAB_A);
    const forward = await service.goForward();
    expect(forward.action).toBe("forward");
    const reloaded = await service.reload(true);
    expect(reloaded.action).toBe("reload");
    expect(reloaded.tab.id).toBe(TAB_A);

    const bare = new BrowserService();
    await expect(bare.navigate("https://example.com/")).rejects.toMatchObject({
      code: "BROWSER_OPERATION_NOT_IMPLEMENTED",
    });
    await expect(bare.goBack()).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(bare.goForward()).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(bare.reload()).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
  });
});
