import type {
  CapabilityMatrix,
  CheckStatus,
  ChromeApi,
  DebugTarget,
  DiagnosticReport,
  TestTab,
} from "./types.js";

/**
 * Browser-side feasibility orchestration for arc-mcp.
 *
 * Uses ONLY a dedicated disposable test tab created by the runner: it never
 * touches the user's existing tabs. Every step records pass/fail plus safe
 * evidence; failures in non-required domains do not abort the suite, but a
 * debugger-attach failure stops all deeper CDP tests.
 *
 * The report (including the verdict) is built after best-effort cleanup, so
 * detach/remove outcomes are always reflected.
 */

export const TEST_URL = "https://example.com/";
/**
 * Single debugger protocol version. "1.3" is the only version probed;
 * no fallback probing of any kind.
 */
export const DEBUG_PROTOCOL_VERSION = "1.3";
const NETWORK_COLLECT_TIMEOUT_MS = 12_000;
const NETWORK_TARGET_EVENTS = 5;
const TAB_READY_TIMEOUT_MS = 15_000;

interface MutableMatrix {
  tabs: { create: CheckStatus; query: CheckStatus; update: CheckStatus; remove: CheckStatus };
  debugger: { attach: CheckStatus; detach: CheckStatus };
  cdp: {
    Runtime: CheckStatus;
    DOM: CheckStatus;
    Accessibility: CheckStatus;
    DOMSnapshot: CheckStatus;
    Page: CheckStatus;
    Page_captureScreenshot: CheckStatus;
    Network: CheckStatus;
    Input: CheckStatus;
    Target: CheckStatus;
    Storage: CheckStatus;
  };
}

function freshMatrix(): MutableMatrix {
  const pending: CheckStatus = "not_tested";
  return {
    tabs: { create: pending, query: pending, update: pending, remove: pending },
    debugger: { attach: pending, detach: pending },
    cdp: {
      Runtime: pending,
      DOM: pending,
      Accessibility: pending,
      DOMSnapshot: pending,
      Page: pending,
      Page_captureScreenshot: pending,
      Network: pending,
      Input: pending,
      Target: pending,
      Storage: pending,
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unparseable-url";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Safe origin for quota-only Storage probes; falls back to the test URL. */
function tabOrigin(testUrl: string): string {
  try {
    return new URL(testUrl).origin;
  } catch {
    return "https://example.com";
  }
}

export interface RunOptions {
  readonly testUrl?: string;
  /** Bound for Network event collection (default 12s; tests use less). */
  readonly networkCollectTimeoutMs?: number;
  /** Bound for test-tab readiness (default 15s; tests use less). */
  readonly tabReadyTimeoutMs?: number;
  /** Called after every check settles with a live matrix snapshot. */
  readonly onProgress?: (currentCheck: string, capabilities: CapabilityMatrix) => void;
}

function isExpectedUrl(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) {
    return false;
  }
  try {
    const got = new URL(actual);
    const want = new URL(expected);
    return got.origin === want.origin && got.pathname.startsWith(want.pathname);
  } catch {
    return false;
  }
}

function isReadyTab(tab: TestTab, expectedUrl: string): boolean {
  return tab.status === "complete" && isExpectedUrl(tab.url, expectedUrl);
}

/**
 * Wait until the dedicated test tab commits the expected URL and finishes
 * loading. Event-driven via onUpdated, bounded by timeout, scoped to tabId
 * only (unrelated tabs ignored), listeners always removed. Rejects when the
 * tab closes or the bound expires.
 */
export function waitForTabReady(
  api: ChromeApi,
  tabId: number,
  expectedUrl: string,
  timeoutMs: number,
): Promise<TestTab> {
  return new Promise<TestTab>((resolve, reject) => {
    let settled = false;
    const done = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      api.tabs.removeOnUpdatedListener(listener);
      action();
    };
    const check = (tab: TestTab): void => {
      if (isReadyTab(tab, expectedUrl)) {
        done(() => resolve(tab));
      }
    };
    const listener = (updatedId: number): void => {
      if (updatedId !== tabId) {
        return;
      }
      api.tabs.get(tabId).then(
        (tab) => check(tab),
        () => done(() => reject(new Error("test tab was closed during readiness wait"))),
      );
    };
    const timer = setTimeout(() => {
      done(() => reject(new Error(`test tab did not reach ready state within ${String(timeoutMs)}ms`)));
    }, timeoutMs);
    api.tabs.onUpdated(listener);
    // Race: the tab may already be complete before we subscribed.
    api.tabs.get(tabId).then(
      (tab) => check(tab),
      () => done(() => reject(new Error("test tab was closed during readiness wait"))),
    );
  });
}

/**
 * Run the full feasibility suite against a dedicated test tab.
 * Always attempts debugger detach + test-tab removal before returning,
 * even when steps fail.
 */
export async function runDiagnostics(api: ChromeApi, options: RunOptions = {}): Promise<DiagnosticReport> {
  const testUrl = options.testUrl ?? TEST_URL;
  const versions = api.versions();
  const capabilities = freshMatrix();
  const errors: Record<string, string> = {};
  const evidence: Record<string, string | number | boolean> = { testUrl };
  const notes: string[] = [];

  const emit = (check: string): void => {
    try {
      options.onProgress?.(check, capabilities);
    } catch {
      // Progress reporting is best-effort; it must never fail the run.
    }
  };

  const fail = (key: string, error: unknown): void => {
    errors[key] = messageOf(error);
    emit(key);
  };

  let tabId: number | null = null;
  let attached = false;
  let detachObserved = false;
  api.debugger.onDetach(() => {
    detachObserved = true;
  });

  const target = (): DebugTarget => {
    if (tabId === null) {
      throw new Error("no test tab");
    }
    return { tabId };
  };

  const send = (
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => api.debugger.sendCommand(target(), method, params);

  // ---- main flow (early returns skip remaining steps, never cleanup) ----
  async function flow(): Promise<void> {
    // ---- tabs.create ----
    try {
      const tab: TestTab = await api.tabs.create({ url: testUrl, active: false });
      if (tab.id === undefined) {
        throw new Error("tabs.create returned no tab id");
      }
      tabId = tab.id;
      capabilities.tabs.create = "pass";
      evidence["tabId"] = tabId;
    } catch (error: unknown) {
      capabilities.tabs.create = "fail";
      fail("tabs.create", error);
      return;
    }
    emit("tabs.create");

    // ---- tabs.get/query ----
    try {
      const listed = await api.tabs.query({});
      const visible = listed.some((entry) => entry.id === tabId);
      if (!visible) {
        throw new Error("created tab not visible in tabs.query");
      }
      capabilities.tabs.query = "pass";
      evidence["queryVisible"] = true;
    } catch (error: unknown) {
      capabilities.tabs.query = "fail";
      fail("tabs.query", error);
    }
    emit("tabs.query");

    // ---- tabs.update (non-activating: the test tab must stay in the background) ----
    try {
      await api.tabs.update(tabId, { active: false });
      capabilities.tabs.update = "pass";
    } catch (error: unknown) {
      capabilities.tabs.update = "fail";
      fail("tabs.update", error);
    }
    emit("tabs.update");

    // ---- readiness: committed expected URL + complete load, bounded ----
    try {
      const ready = await waitForTabReady(
        api,
        tabId,
        testUrl,
        options.tabReadyTimeoutMs ?? TAB_READY_TIMEOUT_MS,
      );
      evidence["tabTitle"] = typeof ready.title === "string" ? ready.title.slice(0, 80) : "unknown";
      evidence["tabUrl"] = typeof ready.url === "string" ? ready.url.slice(0, 120) : "unknown";
      evidence["tabReady"] = true;
    } catch (error: unknown) {
      fail("tab.readiness", error);
      notes.push("Test tab never reached a usable ready state; debugger tests skipped.");
      return;
    }

    // ---- debugger.attach (gate for every CDP test) ----
    try {
      await api.debugger.attach(target(), DEBUG_PROTOCOL_VERSION);
      attached = true;
      capabilities.debugger.attach = "pass";
      evidence["debugProtocolVersion"] = DEBUG_PROTOCOL_VERSION;
    } catch (error: unknown) {
      capabilities.debugger.attach = "fail";
      fail("debugger.attach", error);
      notes.push("Debugger attach failed; all CDP domain tests skipped (verdict BLOCKED).");
      return;
    }
    emit("debugger.attach");

    // ---- Runtime ----
    try {
      await send("Runtime.enable");
      const evaluated = await send("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      });
      const result = isRecord(evaluated["result"]) ? evaluated["result"] : null;
      const title = result !== null && typeof result["value"] !== "undefined" ? String(result["value"]) : null;
      if (title === null) {
        throw new Error("Runtime.evaluate returned no value");
      }
      capabilities.cdp.Runtime = "pass";
      evidence["documentTitle"] = title.slice(0, 80);
    } catch (error: unknown) {
      capabilities.cdp.Runtime = "fail";
      fail("Runtime", error);
    }
    emit("Runtime");

    // ---- DOM ----
    try {
      const document = await send("DOM.getDocument", { depth: 2 });
      const root = isRecord(document["root"]) ? document["root"] : null;
      if (root === null || typeof root["nodeId"] === "undefined") {
        throw new Error("DOM.getDocument returned no root node");
      }
      capabilities.cdp.DOM = "pass";
      evidence["domRootNodeId"] = String(root["nodeId"]);
      const children = root["children"];
      evidence["domRootChildren"] = Array.isArray(children) ? children.length : 0;
    } catch (error: unknown) {
      capabilities.cdp.DOM = "fail";
      fail("DOM", error);
    }
    emit("DOM");

    // ---- Accessibility (semantic snapshot foundation) ----
    try {
      await send("Accessibility.enable");
      const tree = await send("Accessibility.getFullAXTree", {});
      const nodes = tree["nodes"];
      if (!Array.isArray(nodes) || nodes.length === 0) {
        throw new Error("Accessibility.getFullAXTree returned no nodes");
      }
      capabilities.cdp.Accessibility = "pass";
      evidence["axNodeCount"] = nodes.length;
      const samples: string[] = [];
      for (const node of nodes.slice(0, 12)) {
        if (isRecord(node) && isRecord(node["role"])) {
          const role = typeof node["role"]["value"] === "string" ? node["role"]["value"] : "?";
          const name = isRecord(node["name"]) && typeof node["name"]["value"] === "string"
            ? node["name"]["value"].slice(0, 40)
            : "";
          samples.push(`${role}:${name}`);
        }
      }
      evidence["axSample"] = samples.join(" | ").slice(0, 400);
    } catch (error: unknown) {
      capabilities.cdp.Accessibility = "fail";
      fail("Accessibility", error);
    }
    emit("Accessibility");

    // ---- DOMSnapshot ----
    try {
      const snapshot = await send("DOMSnapshot.captureSnapshot", { computedStyles: [] });
      const documents = snapshot["documents"];
      if (!Array.isArray(documents) || documents.length === 0) {
        throw new Error("DOMSnapshot.captureSnapshot returned no documents");
      }
      capabilities.cdp.DOMSnapshot = "pass";
      evidence["domSnapshotDocuments"] = documents.length;
      const strings = snapshot["strings"];
      evidence["domSnapshotStrings"] = Array.isArray(strings) ? strings.length : 0;
    } catch (error: unknown) {
      capabilities.cdp.DOMSnapshot = "fail";
      fail("DOMSnapshot", error);
    }
    emit("DOMSnapshot");

    // ---- Page (+ screenshot payload proof) ----
    try {
      await send("Page.enable");
      const frameTree = await send("Page.getFrameTree", {});
      const frame = isRecord(frameTree["frameTree"]) && isRecord(frameTree["frameTree"]["frame"])
        ? (frameTree["frameTree"]["frame"] as Record<string, unknown>)
        : null;
      if (frame === null || typeof frame["url"] !== "string") {
        throw new Error("Page.getFrameTree returned no frame URL");
      }
      capabilities.cdp.Page = "pass";
      evidence["frameUrl"] = String(frame["url"]).slice(0, 120);
      try {
        const shot = await send("Page.captureScreenshot", { format: "png" });
        const data = typeof shot["data"] === "string" ? shot["data"] : "";
        if (data.length === 0) {
          throw new Error("empty screenshot payload");
        }
        capabilities.cdp.Page_captureScreenshot = "pass";
        evidence["screenshotBase64Length"] = data.length;
      } catch (error: unknown) {
        capabilities.cdp.Page_captureScreenshot = "fail";
        fail("Page.captureScreenshot", error);
      }
      emit("Page.captureScreenshot");
    } catch (error: unknown) {
      capabilities.cdp.Page = "fail";
      fail("Page", error);
    }
    emit("Page");

    // ---- Network (events generated only by our own tab reload) ----
    try {
      await send("Network.enable");
      const seen: string[] = [];
      api.debugger.onEvent((_source, method, params) => {
        if (method === "Network.requestWillBeSent" || method === "Network.responseReceived") {
          const url = isRecord(params) && isRecord(params["request"]) && typeof params["request"]["url"] === "string"
            ? String(params["request"]["url"])
            : isRecord(params) && isRecord(params["response"]) && typeof params["response"]["url"] === "string"
              ? String(params["response"]["url"])
              : "";
          const status = isRecord(params) && isRecord(params["response"]) && typeof params["response"]["status"] !== "undefined"
            ? String(params["response"]["status"])
            : "";
          seen.push(`${method} ${hostOf(url)}${status === "" ? "" : ` ${status}`}`.slice(0, 120));
        }
      });
      await api.tabs.reload(tabId);
      const deadline = Date.now() + (options.networkCollectTimeoutMs ?? NETWORK_COLLECT_TIMEOUT_MS);
      while (seen.length < NETWORK_TARGET_EVENTS && Date.now() < deadline) {
        await delay(250);
      }
      try {
        await send("Network.disable");
      } catch {
        // Best effort; the capability result below already reflects the outcome.
      }
      if (seen.length === 0) {
        throw new Error("no Network events observed after reload");
      }
      capabilities.cdp.Network = "pass";
      evidence["networkEvents"] = seen.length;
      evidence["networkSample"] = seen.slice(0, 4).join(" | ").slice(0, 400);
    } catch (error: unknown) {
      capabilities.cdp.Network = "fail";
      fail("Network", error);
    }
    emit("Network");

    // ---- Input (non-destructive mouse move in our own tab) ----
    try {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 10 });
      capabilities.cdp.Input = "pass";
    } catch (error: unknown) {
      capabilities.cdp.Input = "fail";
      fail("Input", error);
    }
    emit("Input");

    // ---- Target (chrome.debugger.getTargets API only; never a CDP command) ----
    try {
      const targets = await api.debugger.getTargets();
      const types = [...new Set(targets.map((entry) => entry.type))];
      capabilities.cdp.Target = "pass";
      evidence["targetCount"] = targets.length;
      evidence["targetTypes"] = types.join(",").slice(0, 120);
      evidence["testTabTargetSeen"] = tabId === null
        ? false
        : targets.some((entry) => entry.tabId === tabId);
    } catch (error: unknown) {
      capabilities.cdp.Target = "fail";
      fail("Target", error);
    }
    emit("Target");

    // ---- Storage (quota/usage metadata only; never content) ----
    try {
      const origin = tabOrigin(testUrl);
      const usage = await send("Storage.getUsageAndQuota", { origin });
      if (typeof usage["usage"] === "undefined") {
        throw new Error("Storage.getUsageAndQuota returned no usage");
      }
      capabilities.cdp.Storage = "pass";
      evidence["storageUsage"] = String(usage["usage"]).slice(0, 40);
      evidence["storageOrigin"] = origin;
    } catch (error: unknown) {
      capabilities.cdp.Storage = "fail";
      fail("Storage", error);
    }
    emit("Storage");
  }

  try {
    await flow();
  } finally {
    if (detachObserved) {
      notes.push("chrome.debugger.onDetach fired during the run (e.g. DevTools opened on the test tab).");
    }
    // Best-effort cleanup: detach first, then remove only our own test tab.
    if (attached && tabId !== null) {
      try {
        await api.debugger.detach({ tabId });
        capabilities.debugger.detach = "pass";
      } catch (error: unknown) {
        capabilities.debugger.detach = "fail";
        fail("debugger.detach", error);
      }
      emit("debugger.detach");
    }
    if (tabId !== null) {
      try {
        await api.tabs.remove(tabId);
        capabilities.tabs.remove = "pass";
      } catch (error: unknown) {
        capabilities.tabs.remove = "fail";
        fail("tabs.remove", error);
      }
      emit("tabs.remove");
    }
  }

  return {
    arcVersion: versions.arc,
    chromiumVersion: versions.chromium,
    manifestVersion: 3,
    testUrl,
    testTabId: tabId,
    capabilities: capabilities as CapabilityMatrix,
    errors,
    evidence,
    verdict: computeVerdict(capabilities),
    notes,
  };
}

/**
 * SUPPORTED requires the full mandatory set: tabs create/query/update/remove,
 * debugger attach/detach, and Runtime, DOM, Accessibility, Page, Network,
 * Input. DOMSnapshot, screenshot, Target, and Storage are desirable-only and
 * reported individually.
 */
export function computeVerdict(matrix: CapabilityMatrix): "SUPPORTED" | "BLOCKED" {
  const required: CheckStatus[] = [
    matrix.tabs.create,
    matrix.tabs.query,
    matrix.tabs.update,
    matrix.tabs.remove,
    matrix.debugger.attach,
    matrix.debugger.detach,
    matrix.cdp.Runtime,
    matrix.cdp.DOM,
    matrix.cdp.Accessibility,
    matrix.cdp.Page,
    matrix.cdp.Network,
    matrix.cdp.Input,
  ];
  return required.every((status) => status === "pass") ? "SUPPORTED" : "BLOCKED";
}
