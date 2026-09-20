import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import type { BridgeTransportMethod } from "../src/browser/extension/BridgeRuntime.js";
import { BridgeRuntime } from "../src/browser/extension/BridgeRuntime.js";
import { ArcExtensionEngine } from "../src/browser/extension/ArcExtensionEngine.js";
import { BrowserService } from "../src/browser/BrowserService.js";
import { ArcError } from "../src/errors/ArcError.js";
import type { BrowserTab } from "../src/browser/models.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

interface ScriptedTab {
  chromeId: number;
  title: string;
  url: string;
  active: boolean;
}

function record(chromeId: number, overrides: Partial<ScriptedTab> = {}): BrowserTab {
  return {
    id: `t-${String(chromeId)}`,
    title: overrides.title ?? `Tab ${String(chromeId)}`,
    url: overrides.url ?? "https://example.com/",
    active: overrides.active ?? false,
    pinned: false,
    windowId: 1,
    controllable: true,
  };
}

class FakeTabsRuntime extends BridgeRuntime {
  tabs = new Map<number, BrowserTab>([
    [11, record(11, { title: "User Tab", active: true })],
    [22, record(22, { title: "Other", active: false })],
  ]);
  relayConnected = true;
  requests: Array<{ method: string; payload: Record<string, unknown> }> = [];
  failNext: BridgeError | null = null;

  constructor() {
    super({ pipeName: "\\\\.\\pipe\\arc-mcp-fake-tabs", sessionDir: "C:\\arc-mcp-fake-tabs" });
  }

  override async start(): Promise<void> {
    // No-op: scripted transport needs no OS resources.
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

  private liveRecords(): BrowserTab[] {
    return [...this.tabs.values()];
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
      return { tabs: this.liveRecords() };
    }
    if (method === "tabs.open") {
      const url = payload["url"];
      if (typeof url === "string" && url.startsWith("javascript:")) {
        throw new BridgeError("INVALID_ENVELOPE", "remote rejected scheme");
      }
      const chromeId = Math.max(0, ...this.tabs.keys()) + 1;
      const created = record(chromeId, {
        title: "New Tab",
        url: typeof url === "string" ? url : "",
        active: true,
      });
      for (const existing of this.tabs.values()) {
        (existing as { active: boolean }).active = false;
      }
      this.tabs.set(chromeId, created);
      return { tab: created };
    }
    if (method === "tabs.activate" || method === "tabs.close") {
      const tabId = payload["tabId"];
      if (typeof tabId !== "string") {
        throw new BridgeError("INVALID_ENVELOPE", "missing tabId");
      }
      const match = /^t-(\d+)$/.exec(tabId);
      const chromeId = match?.[1] === undefined ? NaN : Number.parseInt(match[1], 10);
      const found = this.tabs.get(chromeId);
      if (found === undefined) {
        throw new BridgeError("INVALID_ENVELOPE", "remote says gone", { remoteCode: "TAB_NOT_FOUND" });
      }
      if (method === "tabs.activate") {
        for (const existing of this.tabs.values()) {
          (existing as { active: boolean }).active = false;
        }
        (found as { active: boolean }).active = true;
        return { tab: { ...found } };
      }
      this.tabs.delete(chromeId);
      return { closed: tabId };
    }
    if (method === "bridge.status" || method === "bridge.ping" || method === "bridge.hello") {
      return { connected: true };
    }
    throw new BridgeError("INVALID_ENVELOPE", `unexpected method ${method}`);
  }
}

function engineWith(): { engine: ArcExtensionEngine; runtime: FakeTabsRuntime } {
  const runtime = new FakeTabsRuntime();
  const engine = new ArcExtensionEngine({
    runtime,
    extensionId: EXTENSION_ID,
    connectTimeoutMs: 2_000,
    checkPrerequisites: () => Promise.resolve([]),
  });
  return { engine, runtime };
}

async function connectedEngine(): Promise<{ engine: ArcExtensionEngine; runtime: FakeTabsRuntime }> {
  const harness = engineWith();
  await harness.engine.connect();
  return harness;
}

describe("engine tab operations", () => {
  it("lists stable tabs and keeps selection valid", async () => {
    const { engine } = await connectedEngine();
    const first = await engine.listTabs();
    const second = await engine.listTabs();
    expect(first.map((tab) => tab.id)).toEqual(["t-11", "t-22"]);
    expect(second.map((tab) => tab.id)).toEqual(["t-11", "t-22"]);
    expect((await engine.status()).selectedTabId).toBeNull();
  });

  it("opening a tab selects the created tab", async () => {
    const { engine } = await connectedEngine();
    const created = await engine.openTab("https://example.com/");
    expect(created.id).toBe("t-23");
    expect(created.url).toBe("https://example.com/");
    expect((await engine.status()).selectedTabId).toBe("t-23");
  });

  it("selecting updates logical selection without touching others", async () => {
    const { engine } = await connectedEngine();
    await engine.selectTab("t-22");
    expect((await engine.status()).selectedTabId).toBe("t-22");
    const tabs = await engine.listTabs();
    expect(tabs.find((tab) => tab.id === "t-11")?.active).toBe(false);
  });

  it("closing the selected tab clears selection; closing others keeps it", async () => {
    const { engine } = await connectedEngine();
    await engine.selectTab("t-22");
    await engine.closeTab("t-11");
    expect((await engine.status()).selectedTabId).toBe("t-22");
    await engine.closeTab("t-22");
    expect((await engine.status()).selectedTabId).toBeNull();
  });

  it("stale IDs fail with BROWSER_TAB_NOT_FOUND and never fall back", async () => {
    const { engine } = await connectedEngine();
    await engine.selectTab("t-11");
    await engine.closeTab("t-11");
    let caught: unknown = null;
    try {
      await engine.selectTab("t-11");
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ArcError);
    expect((caught as ArcError).code).toBe("BROWSER_TAB_NOT_FOUND");
    expect((await engine.status()).selectedTabId).toBeNull();
  });

  it("rejects dangerous open schemes before any bridge traffic", async () => {
    const { engine, runtime } = await connectedEngine();
    const before = runtime.requests.length;
    for (const url of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "chrome://settings",
      "chrome-extension://abc",
      "arc://extensions",
    ]) {
      let caught: unknown = null;
      try {
        await engine.openTab(url);
      } catch (error: unknown) {
        caught = error;
      }
      expect((caught as ArcError).code).toBe("BROWSER_TAB_CREATE_FAILED");
    }
    expect(runtime.requests.length).toBe(before);
  });

  it("external close heals selection on next list", async () => {
    const { engine, runtime } = await connectedEngine();
    await engine.selectTab("t-11");
    runtime.tabs.delete(11);
    expect((await engine.listTabs()).map((tab) => tab.id)).toEqual(["t-22"]);
    expect((await engine.status()).selectedTabId).toBeNull();
  });

  it("discovers externally opened tabs", async () => {
    const { engine, runtime } = await connectedEngine();
    runtime.tabs.set(99, record(99, { url: "https://user.example/" }));
    const tabs = await engine.listTabs();
    expect(tabs.map((tab) => tab.id)).toContain("t-99");
  });

  it("exposes no numeric IDs through engine outputs", async () => {
    const { engine } = await connectedEngine();
    const tabs = await engine.listTabs();
    for (const tab of tabs) {
      expect(tab.id).toMatch(/^t-\d+$/);
    }
  });
});

describe("BrowserService tab delegation", () => {
  it("delegates list/select/open/close and reports selection", async () => {
    const { engine } = await connectedEngine();
    const service = new BrowserService(engine);
    const listed = await service.listTabs();
    expect(listed.tabs).toHaveLength(2);
    expect(listed.selectedTabId).toBeNull();
    const opened = await service.openTab("https://example.com/");
    expect(opened.selectedTabId).toBe(opened.tab.id);
    const selected = await service.selectTab("t-11");
    expect(selected.tab.id).toBe("t-11");
    expect(selected.selectedTabId).toBe("t-11");
    const closed = await service.closeTab(opened.tab.id);
    expect(closed.closedTabId).toBe(opened.tab.id);
    expect(closed.selectedTabId).toBe("t-11");
  });

  it("reports not-implemented without an engine", async () => {
    const service = new BrowserService();
    await expect(service.listTabs()).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(service.selectTab("t-1")).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(service.openTab()).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(service.closeTab("t-1")).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
  });
});
