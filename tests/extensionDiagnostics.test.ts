import { describe, expect, it } from "vitest";
import type { ChromeApi, CapabilityMatrix, TabUpdatedListener, TestTab } from "../extension/src/types.js";
import { computeVerdict, DEBUG_PROTOCOL_VERSION, runDiagnostics, waitForTabReady } from "../extension/src/diagnostics.js";

const TEST_TAB_ID = 7;

type EventListener = (
  source: { tabId?: number },
  method: string,
  params?: Record<string, unknown>,
) => void;

interface MockChrome {
  readonly api: ChromeApi;
  readonly removedTabs: number[];
  readonly detachedTabs: number[];
  readonly attachedTabs: number[];
  readonly attachVersions: string[];
  readonly storageOrigins: string[];
  readonly updateListeners: Set<TabUpdatedListener>;
  tabState: TestTab;
  failMethods: Set<string>;
  failCreate: boolean;
  failGet: boolean;
}

function mockChrome(): MockChrome {
  const removedTabs: number[] = [];
  const detachedTabs: number[] = [];
  const attachedTabs: number[] = [];
  const attachVersions: string[] = [];
  const storageOrigins: string[] = [];
  const updateListeners = new Set<TabUpdatedListener>();
  const failMethods = new Set<string>();
  let eventListener: EventListener | null = null;
  const mock: MockChrome = {
    api: {
      tabs: {
        create: (properties) => {
          if (mock.failCreate) {
            return Promise.reject(new Error("tabs.create denied"));
          }
          return Promise.resolve({ id: TEST_TAB_ID, url: properties.url, title: "", status: "loading" });
        },
        get: (tabId) => {
          if (mock.failGet) {
            return Promise.reject(new Error(`No tab with id: ${String(tabId)}`));
          }
          return Promise.resolve({ ...mock.tabState, id: tabId });
        },
        query: () => Promise.resolve([{ ...mock.tabState, id: TEST_TAB_ID }]),
        update: (tabId) => Promise.resolve({ ...mock.tabState, id: tabId }),
        reload: (tabId) => {
          // Simulate real async network events from our own tab only.
          const extra = [
            "https://example.com/",
            "https://example.com/favicon.ico",
            "https://example.com/style.css",
          ];
          setImmediate(() => {
            for (const url of extra) {
              eventListener?.({ tabId }, "Network.requestWillBeSent", { request: { url } });
              eventListener?.({ tabId }, "Network.responseReceived", {
                response: { url, status: 200 },
              });
            }
          });
          return Promise.resolve();
        },
        remove: (tabId) => {
          removedTabs.push(tabId);
          return Promise.resolve();
        },
        onUpdated: (listener) => {
          updateListeners.add(listener);
        },
        removeOnUpdatedListener: (listener) => {
          updateListeners.delete(listener);
        },
      },
      debugger: {
        attach: (target, version) => {
          if (failMethods.has("debugger.attach")) {
            return Promise.reject(new Error("No debugger permission"));
          }
          attachedTabs.push(target.tabId);
          attachVersions.push(version);
          return Promise.resolve();
        },
        sendCommand: (_target, method, params) => {
          if (failMethods.has(method)) {
            return Promise.reject(new Error(`${method} failed`));
          }
          switch (method) {
            case "Runtime.evaluate":
              return Promise.resolve({ result: { value: "Example Domain" } });
            case "DOM.getDocument":
              return Promise.resolve({ root: { nodeId: 1, children: [{ nodeId: 2 }] } });
            case "Accessibility.getFullAXTree":
              return Promise.resolve({
                nodes: [
                  { role: { value: "RootWebArea" }, name: { value: "" } },
                  { role: { value: "heading" }, name: { value: "Example Domain" } },
                ],
              });
            case "DOMSnapshot.captureSnapshot":
              return Promise.resolve({ documents: [{}], strings: ["a", "b"] });
            case "Page.getFrameTree":
              return Promise.resolve({ frameTree: { frame: { url: "https://example.com/" } } });
            case "Page.captureScreenshot":
              return Promise.resolve({ data: "aVBORw0KGgoAAAANSUhEUg==" });
            case "Target.getTargets":
              // Real Arc rejects this CDP command ("Not allowed"); the runner
              // must use debugger.getTargets instead.
              return Promise.reject(new Error("Not allowed"));
            case "Storage.getUsageAndQuota": {
              const origin = params !== undefined && typeof params["origin"] === "string"
                ? String(params["origin"])
                : "";
              storageOrigins.push(origin);
              if (origin === "") {
                return Promise.reject(new Error("Storage.getUsageAndQuota: missing origin"));
              }
              return Promise.resolve({ usage: 1234, quota: 9999 });
            }
            default:
              return Promise.resolve({});
          }
        },
        getTargets: () => {
          if (failMethods.has("debugger.getTargets")) {
            return Promise.reject(new Error("getTargets unavailable"));
          }
          return Promise.resolve([
            { tabId: TEST_TAB_ID, type: "page" },
            { tabId: undefined, type: "iframe" },
          ]);
        },
        detach: (target) => {
          detachedTabs.push(target.tabId);
          return Promise.resolve();
        },
        onEvent: (listener) => {
          eventListener = listener;
        },
        onDetach: () => undefined,
      },
      versions: () => ({ arc: "9.9.9", chromium: "120.0.0" }),
    },
    removedTabs,
    detachedTabs,
    attachedTabs,
    attachVersions,
    storageOrigins,
    updateListeners,
    tabState: { id: TEST_TAB_ID, url: "https://example.com/", title: "Example Domain", status: "complete" },
    failMethods,
    failCreate: false,
    failGet: false,
  };
  return mock;
}

function fullPassMatrix(): CapabilityMatrix {
  const pass = "pass" as const;
  return {
    tabs: { create: pass, query: pass, update: pass, remove: pass },
    debugger: { attach: pass, detach: pass },
    cdp: {
      Runtime: pass,
      DOM: pass,
      Accessibility: pass,
      DOMSnapshot: pass,
      Page: pass,
      Page_captureScreenshot: pass,
      Network: pass,
      Input: pass,
      Target: pass,
      Storage: pass,
    },
  };
}

describe("extension diagnostics runner", () => {
  it("reports SUPPORTED with evidence when every capability works", async () => {
    const mock = mockChrome();
    const report = await runDiagnostics(mock.api, { networkCollectTimeoutMs: 2_000 });
    expect(report.verdict).toBe("SUPPORTED");
    expect(report.testTabId).toBe(TEST_TAB_ID);
    expect(report.errors).toEqual({});
    expect(report.evidence["documentTitle"]).toBe("Example Domain");
    expect(report.evidence["axNodeCount"]).toBe(2);
    expect(report.evidence["networkEvents"]).toBe(6);
    expect(String(report.evidence["axSample"])).toContain("heading");
    expect(mock.storageOrigins).toEqual(["https://example.com"]);
    expect(report.evidence["storageOrigin"]).toBe("https://example.com");
    expect(report.evidence["testTabTargetSeen"]).toBe(true);
    expect(report.evidence["targetCount"]).toBe(2);
    expect(mock.attachedTabs).toEqual([TEST_TAB_ID]);
    expect(mock.detachedTabs).toEqual([TEST_TAB_ID]);
    expect(mock.removedTabs).toEqual([TEST_TAB_ID]);
    expect(report.capabilities.debugger.detach).toBe("pass");
    expect(report.capabilities.tabs.remove).toBe("pass");
  });

  it("reports BLOCKED and still cleans up when attach fails", async () => {
    const mock = mockChrome();
    mock.failMethods.add("debugger.attach");
    const report = await runDiagnostics(mock.api);
    expect(report.verdict).toBe("BLOCKED");
    expect(report.capabilities.debugger.attach).toBe("fail");
    expect(report.capabilities.cdp.Runtime).toBe("not_tested");
    expect(report.errors["debugger.attach"]).toContain("No debugger permission");
    expect(mock.removedTabs).toEqual([TEST_TAB_ID]);
    expect(mock.detachedTabs).toEqual([]);
  });

  it("continues after a required-domain failure but stays BLOCKED", async () => {
    const mock = mockChrome();
    mock.failMethods.add("Runtime.evaluate");
    const report = await runDiagnostics(mock.api, { networkCollectTimeoutMs: 2_000 });
    expect(report.capabilities.cdp.Runtime).toBe("fail");
    expect(report.capabilities.cdp.DOM).toBe("pass");
    expect(report.verdict).toBe("BLOCKED");
    expect(mock.removedTabs).toEqual([TEST_TAB_ID]);
  });

  it("stays SUPPORTED when only desirable domains fail", async () => {
    const mock = mockChrome();
    mock.failMethods.add("DOMSnapshot.captureSnapshot");
    mock.failMethods.add("debugger.getTargets");
    mock.failMethods.add("Storage.getUsageAndQuota");
    const report = await runDiagnostics(mock.api, { networkCollectTimeoutMs: 2_000 });
    expect(report.capabilities.cdp.DOMSnapshot).toBe("fail");
    expect(report.capabilities.cdp.Target).toBe("fail");
    expect(report.capabilities.cdp.Storage).toBe("fail");
    expect(report.verdict).toBe("SUPPORTED");
  });

  it("reports BLOCKED without cleanup targets when tab creation fails", async () => {
    const mock = mockChrome();
    mock.failCreate = true;
    const report = await runDiagnostics(mock.api);
    expect(report.verdict).toBe("BLOCKED");
    expect(report.capabilities.tabs.create).toBe("fail");
    expect(mock.attachedTabs).toEqual([]);
    expect(mock.removedTabs).toEqual([]);
  });
});

describe("debugger protocol version pin", () => {
  it("requests exactly 1.3 with no fallback probing", async () => {
    expect(DEBUG_PROTOCOL_VERSION).toBe("1.3");
    const mock = mockChrome();
    await runDiagnostics(mock.api, { networkCollectTimeoutMs: 2_000, tabReadyTimeoutMs: 2_000 });
    expect(mock.attachVersions).toEqual(["1.3"]);
  });
});

describe("waitForTabReady", () => {
  it("resolves immediately when the tab is already complete", async () => {
    const mock = mockChrome();
    const tab = await waitForTabReady(mock.api, TEST_TAB_ID, "https://example.com/", 1_000);
    expect(tab.status).toBe("complete");
    expect(mock.updateListeners.size).toBe(0);
  });

  it("waits for the dedicated tab and ignores unrelated tabs", async () => {
    const mock = mockChrome();
    mock.tabState = { id: TEST_TAB_ID, url: "https://example.com/", title: "", status: "loading" };
    const pending = waitForTabReady(mock.api, TEST_TAB_ID, "https://example.com/", 2_000);
    for (const listener of [...mock.updateListeners]) {
      listener(999, { status: "complete", url: "https://example.com/" });
    }
    mock.tabState = { id: TEST_TAB_ID, url: "https://example.com/", title: "Example Domain", status: "complete" };
    for (const listener of [...mock.updateListeners]) {
      listener(TEST_TAB_ID, { status: "complete", url: "https://example.com/" });
    }
    const tab = await pending;
    expect(tab.title).toBe("Example Domain");
    expect(mock.updateListeners.size).toBe(0);
  });

  it("times out deterministically and removes listeners", async () => {
    const mock = mockChrome();
    mock.tabState = { id: TEST_TAB_ID, url: "https://example.com/", title: "", status: "loading" };
    let caught: unknown = null;
    try {
      await waitForTabReady(mock.api, TEST_TAB_ID, "https://example.com/", 100);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toContain("did not reach ready state within 100ms");
    expect(mock.updateListeners.size).toBe(0);
  });

  it("rejects cleanly when the tab closes mid-wait", async () => {
    const mock = mockChrome();
    mock.tabState = { id: TEST_TAB_ID, url: "https://example.com/", title: "", status: "loading" };
    mock.failGet = true;
    let caught: unknown = null;
    try {
      await waitForTabReady(mock.api, TEST_TAB_ID, "https://example.com/", 2_000);
    } catch (error: unknown) {
      caught = error;
    }
    expect(String((caught as Error).message)).toContain("closed");
    expect(mock.updateListeners.size).toBe(0);
  });

  it("records readiness failure, skips attach, and still removes the tab", async () => {
    const mock = mockChrome();
    mock.tabState = { id: TEST_TAB_ID, url: "https://example.com/", title: "", status: "loading" };
    const report = await runDiagnostics(mock.api, { networkCollectTimeoutMs: 500, tabReadyTimeoutMs: 100 });
    expect(report.errors["tab.readiness"]).toContain("did not reach ready state");
    expect(mock.attachedTabs).toEqual([]);
    expect(mock.removedTabs).toEqual([TEST_TAB_ID]);
    expect(report.verdict).toBe("BLOCKED");
    expect(mock.updateListeners.size).toBe(0);
  });
});

describe("computeVerdict", () => {  it("requires detach and every mandatory domain", () => {
    expect(computeVerdict(fullPassMatrix())).toBe("SUPPORTED");
    const noDetach: CapabilityMatrix = {
      ...fullPassMatrix(),
      debugger: { attach: "pass", detach: "fail" },
    };
    expect(computeVerdict(noDetach)).toBe("BLOCKED");
    const noInput: CapabilityMatrix = {
      ...fullPassMatrix(),
      cdp: { ...fullPassMatrix().cdp, Input: "fail" },
    };
    expect(computeVerdict(noInput)).toBe("BLOCKED");
  });
});
