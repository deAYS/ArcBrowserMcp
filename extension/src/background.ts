import type { CapabilityMatrix, ChromeApi, DiagnosticProgress, TabUpdatedListener, TestTab } from "./types.js";
import { runDiagnostics } from "./diagnostics.js";
import { ExtensionBridge } from "./bridge.js";
import { TabError, TabRegistry, createMemoryTombstoneStore, createSessionTombstoneStore } from "./tabs.js";
import {
  DEBUG_PROTOCOL_VERSION,
  DebuggerSessionManager,
  SnapshotError,
  createMemorySnapshotSessionStorage,
  createSessionSnapshotStorage,
} from "./snapshot.js";
import { validateNavigationUrl } from "../../src/browser/navigationPolicy.js";
import type { TabsChrome } from "./tabs.js";

/**
 * Manifest V3 service worker.
 *
 * All listeners are registered synchronously at worker startup. Diagnostic
 * state for a single run lives in memory; the final report is persisted to
 * chrome.storage.local so the UI survives worker suspension/restart.
 */

const REPORT_STORAGE_KEY = "arcMcpReport";

/**
 * Latest live snapshot of the in-flight diagnostics run (null before the
 * first run). Polled by the diagnostic page; the persisted final report
 * stays authoritative.
 */
let diagnosticsProgress: DiagnosticProgress | null = null;

function settleDiagnosticsProgress(): void {
  if (diagnosticsProgress !== null) {
    diagnosticsProgress = { ...diagnosticsProgress, running: false, currentCheck: null };
  }
}

function parseVersions(userAgent: string): { arc: string; chromium: string } {
  const arc = userAgent.match(/Arc\/([0-9.]+)/);
  const chromium = userAgent.match(/Chrome\/([0-9.]+)/);
  return {
    arc: arc?.[1] ?? "unknown",
    chromium: chromium?.[1] ?? "unknown",
  };
}

function toTestTab(tab: chrome.tabs.Tab): TestTab {
  return { id: tab.id, url: tab.url, title: tab.title, status: tab.status };
}

const updateWrappers = new Map<
  TabUpdatedListener,
  (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => void
>();

const api: ChromeApi = {
  tabs: {
    create: (properties) =>
      chrome.tabs.create({ url: properties.url, active: properties.active ?? false }).then(toTestTab),
    get: (tabId) => chrome.tabs.get(tabId).then(toTestTab),
    query: (queryInfo) => chrome.tabs.query(queryInfo).then((tabs) => tabs.map(toTestTab)),
    update: (tabId, properties) =>
      chrome.tabs.update(tabId, properties).then((tab) => {
        if (tab === undefined) {
          throw new Error("tabs.update returned no tab");
        }
        return toTestTab(tab);
      }),
    reload: (tabId) => chrome.tabs.reload(tabId),
    remove: (tabId) => chrome.tabs.remove(tabId),
    onUpdated: (listener) => {
      const wrapped = (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo): void => {
        const info: { status?: string; url?: string } = {};
        if (changeInfo.status !== undefined) {
          info.status = changeInfo.status;
        }
        if (changeInfo.url !== undefined) {
          info.url = changeInfo.url;
        }
        listener(tabId, info);
      };
      updateWrappers.set(listener, wrapped);
      chrome.tabs.onUpdated.addListener(wrapped);
    },
    removeOnUpdatedListener: (listener) => {
      // Removal is by identity of the original reference; the map bridges
      // to the wrapper actually registered with Chrome.
      const wrapped = updateWrappers.get(listener);
      if (wrapped !== undefined) {
        chrome.tabs.onUpdated.removeListener(wrapped);
        updateWrappers.delete(listener);
      }
    },
  },
  debugger: {
    attach: (target, protocolVersion) => chrome.debugger.attach(target, protocolVersion),
    sendCommand: (target, method, params) =>
      chrome.debugger.sendCommand(target, method, params) as Promise<Record<string, unknown>>,
    detach: (target) => chrome.debugger.detach(target),
  // Debugger event routing lives inside the class; the adapter below
  // forwards ONLY explicitly supported event methods for monitored tabs.
  onEvent: (listener) => {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      listener(
        source.tabId === undefined ? {} : { tabId: source.tabId },
        method,
        isRecord(params) ? params : undefined,
      );
    });
  },
    onDetach: (listener) => {
      chrome.debugger.onDetach.addListener((source, reason) => {
        listener(source.tabId === undefined ? {} : { tabId: source.tabId }, reason);
      });
    },
    getTargets: () =>
      chrome.debugger.getTargets().then((targets) =>
        targets.map((entry) => ({ tabId: entry.tabId, type: entry.type })),
      ),
  },
  versions: () => parseVersions(navigator.userAgent),
};

declare const __BUILD_ID__: string;

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("diagnostic/diagnostic.html") });
  }
});

// Transport bridge: long-lived Native Messaging port owned by the
// extension, with bounded backoff reconnect. Answers only the transport
// primitives (hello/ping/status); no browser business logic here.
const bridge = new ExtensionBridge((hostName) => {
  const port = chrome.runtime.connectNative(hostName);
  return {
    postMessage: (message: unknown) => port.postMessage(message),
    disconnect: () => port.disconnect(),
    onMessage: (listener) => {
      port.onMessage.addListener(listener);
    },
    onDisconnect: (listener) => {
      port.onDisconnect.addListener(listener);
    },
    lastError: () => chrome.runtime.lastError?.message,
  };
});

// Chrome truth stays extension-side in TabRegistry; Node receives
// project-owned records through explicit RPC.
// NOTE: exactly ONE onRemoteRequest registration may exist (bridge.ts
// throws on a second). Transport primitives (bridge.ping/hello/status) are
// answered first inside the single handler below so the bridge always
// connects even if a later tabs/navigation branch throws.
function toTabsChrome(): TabsChrome {
  const pick = (tab: chrome.tabs.Tab) => ({
    id: tab.id,
    url: tab.url,
    pendingUrl: tab.pendingUrl,
    title: tab.title,
    active: tab.active,
    pinned: tab.pinned,
    windowId: tab.windowId,
    index: tab.index,
  });
  return {
    query: () => chrome.tabs.query({}).then((tabs) => tabs.map(pick)),
    create: (properties) => chrome.tabs.create(properties).then(pick),
    update: (tabId, properties) => chrome.tabs.update(tabId, properties).then((tab) => tab === undefined ? undefined : pick(tab)),
    get: (tabId) => chrome.tabs.get(tabId).then(pick),
    remove: (tabIds) => chrome.tabs.remove(tabIds).then(() => undefined),
    goBack: (tabId) => chrome.tabs.goBack(tabId),
    goForward: (tabId) => chrome.tabs.goForward(tabId),
    reload: (tabId, bypassCache) =>
      bypassCache === true
        ? chrome.tabs.reload(tabId, { bypassCache: true })
        : chrome.tabs.reload(tabId),
    onCreated: (listener) => {
      chrome.tabs.onCreated.addListener((tab) => listener(pick(tab)));
    },
    onRemoved: (listener) => {
      chrome.tabs.onRemoved.addListener((tabId) => listener(tabId));
    },
    onUpdated: (listener) => {
      chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
        if (tab !== undefined) {
          listener(tabId, pick(tab));
        }
      });
    },
    onReplaced: (listener) => {
      chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => listener(addedTabId, removedTabId));
    },
  };
}

function createRetiredStore() {
  try {
    const area = chrome.storage.session;
    if (area === undefined) {
      throw new Error("session storage unavailable");
    }
    return createSessionTombstoneStore({
      get: (key: string) => chrome.storage.session.get(key) as Promise<Record<string, unknown>>,
      set: (items: Record<string, unknown>) => chrome.storage.session.set(items).then(() => undefined),
    });
  } catch {
    return createMemoryTombstoneStore();
  }
}

const tabRegistry = new TabRegistry(createRetiredStore());

// Snapshot capture: DebuggerSessionManager owns debugger attachment
// lifecycle + latest-snapshot-only refs. Chrome truth stays extension-side;
// Node receives the semantic result through the typed snapshot.capture RPC.
// Lazy persistent attachment: retained while the tab remains
// useful so interactions reuse the session; cleared on detach / tab
// close / bridge shutdown. Worker suspension is safe: session storage
// restores the session id so live refs survive suspension, while a real
// restart mints a new session and old refs fail closed.
function createSnapshotSessionStore() {
  try {
    const area = chrome.storage.session;
    if (area === undefined) {
      throw new Error("session storage unavailable");
    }
    return createSessionSnapshotStorage({
      get: (key: string) => chrome.storage.session.get(key) as Promise<Record<string, unknown>>,
      set: (items: Record<string, unknown>) => chrome.storage.session.set(items).then(() => undefined),
    });
  } catch {
    return createMemorySnapshotSessionStorage();
  }
}

function toSnapshotRecord(chromeId: number): { id: string; url: string; title: string } | null {
  const record = tabRegistry.currentRecord(chromeId);
  return record === null ? null : { id: record.id, url: record.url, title: record.title };
}

// Authoritative per-tab loading status for wait-for-load polls, fed by the
// same chrome.tabs.onUpdated truth that drives ref invalidation below.
// Defaults to "complete" for tabs never observed loading (e.g. tabs that
// committed before the worker started); "loading" is set on every load
// commit and cleared on completion.
const tabLoadStatus = new Map<number, string>();

const snapshotManager = new DebuggerSessionManager(
  {
    attach: (tabId) => chrome.debugger.attach({ tabId }, DEBUG_PROTOCOL_VERSION),
    sendCommand: (tabId, method, params) =>
      chrome.debugger.sendCommand({ tabId }, method, params) as Promise<Record<string, unknown>>,
    detach: (tabId) => chrome.debugger.detach({ tabId }),
    onDetach: (listener) => {
      chrome.debugger.onDetach.addListener((source, reason) => {
        listener(source.tabId, reason);
      });
    },
  },
  (projectId) => tabRegistry.resolve(toTabsChrome(), projectId),
  (chromeId) => toSnapshotRecord(chromeId),
  createSnapshotSessionStore(),
  {},
  (chromeId) => tabLoadStatus.get(chromeId) ?? "complete",
);

// Any top-level load commit (navigation, reload incl. external same-URL
// reload, history traversal, or an external actor) invalidates
// latest-snapshot-only refs for that tab. changeInfo.status === "loading"
// is the conservative lifecycle signal: a same-URL reload produces a new
// document even though the URL did not change. Title-only updates and tab
// activation never reach this branch. Only snapshot/element refs are
// cleared; the project TabId itself (TabRegistry) is untouched.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    tabLoadStatus.set(tabId, "loading");
  } else if (changeInfo.status === "complete") {
    tabLoadStatus.set(tabId, "complete");
  }
  if (changeInfo.url !== undefined || changeInfo.status === "loading") {
    const record = tab?.url !== undefined ? { url: tab.url } : tabRegistry.currentRecord(tabId);
    if (record !== null) {
      const info: { status?: string; url?: string } = {};
      if (changeInfo.status !== undefined) {
        info.status = changeInfo.status;
      }
      info.url = record.url;
      snapshotManager.handleTabUpdated(tabId, info);
    } else if (changeInfo.status === "loading") {
      const info: { status?: string; url?: string } = { status: changeInfo.status };
      if (changeInfo.url !== undefined) {
        info.url = changeInfo.url;
      }
      snapshotManager.handleTabUpdated(tabId, info);
    }
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  snapshotManager.handleTabRemoved(tabId);
  tabLoadStatus.delete(tabId);
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  snapshotManager.handleTabRemoved(removedTabId);
  snapshotManager.handleTabRemoved(addedTabId);
  tabLoadStatus.delete(removedTabId);
  tabLoadStatus.delete(addedTabId);
});

// Synchronous listener registration at worker startup (eager tombstoning).

// Debugger event routing: ONE extension path. Supported
// observability events are normalized inside the manager; everything else
// is ignored (never forwarded, never stored). Events from unmonitored tabs
// are dropped by the manager's ownership/monitoring guards.
chrome.debugger.onEvent.addListener((source, method, params) => {
  snapshotManager.handleDebuggerEvent(
    source.tabId,
    method,
    isRecord(params) ? (params as Record<string, unknown>) : undefined,
  );
});
tabRegistry.attachListeners({
  onCreated: (listener) => chrome.tabs.onCreated.addListener((tab) => listener({
    id: tab.id,
    url: tab.url,
    pendingUrl: tab.pendingUrl,
    title: tab.title,
    active: tab.active,
    pinned: tab.pinned,
    windowId: tab.windowId,
    index: tab.index,
  })),
  onRemoved: (listener) => chrome.tabs.onRemoved.addListener((tabId) => listener(tabId)),
  onUpdated: (listener) => chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
    if (tab !== undefined) {
      listener(tabId, {
        id: tab.id,
        url: tab.url,
        pendingUrl: tab.pendingUrl,
        title: tab.title,
        active: tab.active,
        pinned: tab.pinned,
        windowId: tab.windowId,
        index: tab.index,
      });
    }
  }),
  onReplaced: (listener) => chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => listener(addedTabId, removedTabId)),
});

function stringParam(payload: Record<string, unknown>, name: string): string | undefined {
  const value = payload[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TabError("TAB_INVALID_ID", `bridge tabs request field ${name} must be a string`);
  }
  return value;
}

/** Local typed error for request-shape failures in the snapshot branch. */
class SnapshotErrorShim extends Error {
  readonly code: "TAB_INVALID_ID" | "TAB_NOT_FOUND" | "TAB_NOT_CONTROLLABLE" | "DEBUGGER_UNAVAILABLE" | "SNAPSHOT_FAILED" | "STALE_ELEMENT" | "ELEMENT_NOT_INTERACTABLE" | "ELEMENT_NOT_EDITABLE" | "INVALID_KEY" | "INTERACTION_FAILED" | "INVALID_TEXT" | "EVALUATION_FAILED" | "EVALUATION_TIMEOUT" | "EVALUATION_RESULT_TOO_LARGE" | "SCREENSHOT_FAILED" | "SCREENSHOT_TOO_LARGE" | "WAIT_TIMEOUT" | "WAIT_ABORTED" | "OBSERVABILITY_FAILED" | "OBSERVABILITY_CONFIG_INVALID";

  constructor(code: SnapshotErrorShim["code"], message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

/**
 * SnapshotError already carries a project-owned code; bridge.ts preserves
 * `error.code`, so Node maps it directly. Unknown failures become
 * SNAPSHOT_FAILED with a safe message.
 */
function toBridgeSnapshotError(error: unknown): Error & { code: string } {
  if (error instanceof SnapshotError) {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    error instanceof Error
  ) {
    return error as Error & { code: string };
  }
  const message = error instanceof Error ? error.message : String(error);
  return new SnapshotErrorShim("SNAPSHOT_FAILED", `snapshot.capture failed: ${message.slice(0, 300)}`);
}

bridge.onRemoteRequest(async (method, payload, _id) => {
  if (method === "bridge.ping") {
    return { pong: true, extension: "arc-mcp-bridge-dev" };
  }
  if (method === "bridge.hello") {
    return { bridgeVersion: 1, extension: "arc-mcp-bridge-dev" };
  }
  if (method === "bridge.status") {
    return { connected: true, extension: "arc-mcp-bridge-dev" };
  }
  if (method === "tabs.list") {
    return { tabs: await tabRegistry.list(toTabsChrome()) };
  }
  if (method === "tabs.open") {
    const url = stringParam(payload, "url");
    return { tab: await tabRegistry.openTab(toTabsChrome(), url) };
  }
  if (method === "tabs.close") {
    const tabId = stringParam(payload, "tabId");
    if (tabId === undefined) {
      throw new TabError("TAB_INVALID_ID", "tabs.close requires tabId");
    }
    const closed = await tabRegistry.closeTab(toTabsChrome(), tabId);
    snapshotManager.invalidateTabByProject(closed.closed);
    return closed;
  }
  if (method === "tabs.activate") {
    const tabId = stringParam(payload, "tabId");
    if (tabId === undefined) {
      throw new TabError("TAB_INVALID_ID", "tabs.activate requires tabId");
    }
    return { tab: await tabRegistry.activateTab(toTabsChrome(), tabId) };
  }
  if (method === "navigation.navigate") {
    const tabId = stringParam(payload, "tabId");
    const url = stringParam(payload, "url");
    if (tabId === undefined) {
      throw new TabError("TAB_INVALID_ID", "navigation.navigate requires tabId");
    }
    if (url === undefined) {
      throw new TabError("TAB_URL_NOT_ALLOWED", "navigation.navigate requires url");
    }
    const navigated = await tabRegistry.navigateTab(toTabsChrome(), tabId, url, validateNavigationUrl);
    snapshotManager.invalidateTabByProject(navigated.id);
    return { tab: navigated, requestedUrl: url };
  }
  if (method === "navigation.back") {
    const tabId = stringParam(payload, "tabId");
    if (tabId === undefined) {
      throw new TabError("TAB_INVALID_ID", "navigation.back requires tabId");
    }
    const tab = await tabRegistry.goBackTab(toTabsChrome(), tabId);
    snapshotManager.invalidateTabByProject(tab.id);
    return { tab };
  }
  if (method === "navigation.forward") {
    const tabId = stringParam(payload, "tabId");
    if (tabId === undefined) {
      throw new TabError("TAB_INVALID_ID", "navigation.forward requires tabId");
    }
    const tab = await tabRegistry.goForwardTab(toTabsChrome(), tabId);
    snapshotManager.invalidateTabByProject(tab.id);
    return { tab };
  }
  if (method === "navigation.reload") {
    const tabId = stringParam(payload, "tabId");
    if (tabId === undefined) {
      throw new TabError("TAB_INVALID_ID", "navigation.reload requires tabId");
    }
    const ignoreCache = payload["ignoreCache"];
    if (ignoreCache !== undefined && typeof ignoreCache !== "boolean") {
      throw new TabError("TAB_INVALID_ID", "navigation.reload field ignoreCache must be a boolean");
    }
    const tab = await tabRegistry.reloadTab(toTabsChrome(), tabId, ignoreCache === true);
    snapshotManager.invalidateTabByProject(tab.id);
    return { tab };
  }
  if (method === "snapshot.capture") {
    const tabId = stringParam(payload, "tabId");
    if (tabId === undefined) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", "snapshot.capture requires tabId");
    }
    const maxNodes = payload["maxNodes"];
    if (maxNodes !== undefined && (typeof maxNodes !== "number" || !Number.isInteger(maxNodes) || maxNodes <= 0)) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", "snapshot.capture field maxNodes must be a positive integer");
    }
    try {
      return await snapshotManager.capture(
        tabId,
        typeof maxNodes === "number" ? maxNodes : undefined,
      );
    } catch (error: unknown) {
      throw toBridgeSnapshotError(error);
    }
  }
  if (method === "interaction.click") {
    const tabId = stringParam(payload, "tabId");
    const ref = stringParam(payload, "ref");
    if (tabId === undefined) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", "interaction.click requires tabId");
    }
    if (ref === undefined) {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.click requires ref");
    }
    const humanize = payload["humanize"];
    if (humanize !== undefined && typeof humanize !== "boolean") {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.click field humanize must be a boolean");
    }
    try {
      return await snapshotManager.clickElement(tabId, ref, humanize === true);
    } catch (error: unknown) {
      throw toBridgeSnapshotError(error);
    }
  }
  if (method === "interaction.fill" || method === "interaction.type") {
    const tabId = stringParam(payload, "tabId");
    const ref = stringParam(payload, "ref");
    if (tabId === undefined) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", `${method} requires tabId`);
    }
    if (ref === undefined) {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", `${method} requires ref`);
    }
    // The text payload is consumed only by the interaction itself; it is
    // never logged, echoed, or included in any error message.
    const text = payload["text"];
    if (typeof text !== "string") {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", `${method} requires text`);
    }
    try {
      return method === "interaction.fill"
        ? await snapshotManager.fillElement(tabId, ref, text)
        : await snapshotManager.typeIntoElement(tabId, ref, text);
    } catch (error: unknown) {
      throw toBridgeSnapshotError(error);
    }
  }
  if (method === "interaction.pressKey") {
    const tabId = stringParam(payload, "tabId");
    const key = stringParam(payload, "key");
    if (tabId === undefined) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", "interaction.pressKey requires tabId");
    }
    if (key === undefined) {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.pressKey requires key");
    }
    try {
      return await snapshotManager.pressKeyOnTab(tabId, key);
    } catch (error: unknown) {
      throw toBridgeSnapshotError(error);
    }
  }
  if (method === "interaction.typeHuman") {
    const tabId = stringParam(payload, "tabId");
    const ref = stringParam(payload, "ref");
    if (tabId === undefined) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", "interaction.typeHuman requires tabId");
    }
    if (ref === undefined) {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.typeHuman requires ref");
    }
    const text = payload["text"];
    if (typeof text !== "string") {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.typeHuman requires text");
    }
    const wpm = payload["wpm"];
    if (wpm !== undefined && (typeof wpm !== "number" || !Number.isInteger(wpm))) {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.typeHuman field wpm must be an integer");
    }
    const mode = payload["mode"];
    if (mode !== undefined && mode !== "keys" && mode !== "insert") {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.typeHuman field mode must be keys or insert");
    }
    try {
      return await snapshotManager.typeHumanElement(
        tabId,
        ref,
        text,
        typeof wpm === "number" ? wpm : undefined,
        mode === "insert" ? "insert" : "keys",
      );
    } catch (error: unknown) {
      throw toBridgeSnapshotError(error);
    }
  }
  if (method === "interaction.pressSequence") {
    const tabId = stringParam(payload, "tabId");
    if (tabId === undefined) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", "interaction.pressSequence requires tabId");
    }
    const keys = payload["keys"];
    if (!Array.isArray(keys)) {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.pressSequence requires keys");
    }
    const delayMs = payload["delayMs"];
    if (delayMs !== undefined && (typeof delayMs !== "number" || !Number.isInteger(delayMs))) {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.pressSequence field delayMs must be an integer");
    }
    try {
      return await snapshotManager.pressSequenceOnTab(
        tabId,
        keys,
        typeof delayMs === "number" ? delayMs : undefined,
      );
    } catch (error: unknown) {
      throw toBridgeSnapshotError(error);
    }
  }
  if (method === "interaction.clickType") {
    const tabId = stringParam(payload, "tabId");
    const ref = stringParam(payload, "ref");
    if (tabId === undefined) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", "interaction.clickType requires tabId");
    }
    if (ref === undefined) {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.clickType requires ref");
    }
    const text = payload["text"];
    if (typeof text !== "string") {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.clickType requires text");
    }
    const humanize = payload["humanize"];
    if (humanize !== undefined && typeof humanize !== "boolean") {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.clickType field humanize must be a boolean");
    }
    const wpm = payload["wpm"];
    if (wpm !== undefined && (typeof wpm !== "number" || !Number.isInteger(wpm))) {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.clickType field wpm must be an integer");
    }
    const clickTypeMode = payload["mode"];
    if (clickTypeMode !== undefined && clickTypeMode !== "keys" && clickTypeMode !== "insert") {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.clickType field mode must be keys or insert");
    }
    const submitKey = payload["submitKey"];
    if (submitKey !== undefined && typeof submitKey !== "string") {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.clickType field submitKey must be a string");
    }
    try {
      return await snapshotManager.clickTypeElement(tabId, ref, text, {
        ...(humanize !== undefined ? { humanize: humanize as boolean } : {}),
        ...(typeof wpm === "number" ? { wpm } : {}),
        ...(clickTypeMode === "keys" || clickTypeMode === "insert" ? { mode: clickTypeMode } : {}),
        ...(typeof submitKey === "string" ? { submitKey } : {}),
      });
    } catch (error: unknown) {
      throw toBridgeSnapshotError(error);
    }
  }
  if (method === "interaction.getText") {
    const tabId = stringParam(payload, "tabId");
    const ref = stringParam(payload, "ref");
    if (tabId === undefined) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", "interaction.getText requires tabId");
    }
    if (ref === undefined) {
      throw new SnapshotErrorShim("SNAPSHOT_FAILED", "interaction.getText requires ref");
    }
    try {
      return await snapshotManager.getElementText(tabId, ref);
    } catch (error: unknown) {
      throw toBridgeSnapshotError(error);
    }
  }
  if (method === "runtime.evaluate") {
    const tabId = stringParam(payload, "tabId");
    if (tabId === undefined) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", "runtime.evaluate requires tabId");
    }
    // The expression source travels only in the CDP params below; it is
    // never logged, echoed, or included in any error message.
    const expression = payload["expression"];
    if (typeof expression !== "string") {
      throw new SnapshotErrorShim("EVALUATION_FAILED", "runtime.evaluate requires expression");
    }
    const timeoutMs = payload["timeoutMs"];
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new SnapshotErrorShim("EVALUATION_FAILED", "runtime.evaluate requires timeoutMs");
    }
    try {
      return await snapshotManager.evaluateElement(tabId, expression, timeoutMs);
    } catch (error: unknown) {
      throw toBridgeSnapshotError(error);
    }
  }
  if (method === "page.screenshot") {
    const tabId = stringParam(payload, "tabId");
    if (tabId === undefined) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", "page.screenshot requires tabId");
    }
    if (payload["data"] !== undefined || payload["mimeType"] !== undefined || payload["fullPage"] !== undefined) {
      throw new SnapshotErrorShim("SCREENSHOT_FAILED", "page.screenshot takes no screenshot parameters");
    }
    try {
      return await snapshotManager.captureScreenshot(tabId);
    } catch (error: unknown) {
      throw toBridgeSnapshotError(error);
    }
  }
  if (method === "wait.check") {
    const tabId = stringParam(payload, "tabId");
    if (tabId === undefined) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", "wait.check requires tabId");
    }
    // One atomic read-only poll against browser truth. Node owns the
    // deadline loop; the extension never sleeps, never runs JS, and never
    // allocates snapshot refs here.
    try {
      return await snapshotManager.waitCheck(tabId, payload);
    } catch (error: unknown) {
      throw toBridgeSnapshotError(error);
    }
  }
  if (method === "observability.consoleGet" || method === "observability.consoleClear") {
    const tabId = stringParam(payload, "tabId");
    if (tabId === undefined) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", `${method} requires tabId`);
    }
    const limit = payload["limit"];
    if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)) {
      throw new SnapshotErrorShim("OBSERVABILITY_FAILED", `${method} field limit must be a positive integer`);
    }
    const capacity = payload["capacity"];
    if (capacity !== undefined && (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity <= 0)) {
      throw new SnapshotErrorShim("OBSERVABILITY_CONFIG_INVALID", `${method} field capacity must be a positive integer`);
    }
    // Read-only for the page: get/clear never navigate, reload, mutate, or
    // invalidate snapshot refs.
    try {
      return method === "observability.consoleGet"
        ? await snapshotManager.getConsole(
          tabId,
          typeof limit === "number" ? limit : undefined,
          typeof capacity === "number" ? capacity : undefined,
        )
        : await snapshotManager.clearConsole(tabId);
    } catch (error: unknown) {
      throw toBridgeSnapshotError(error);
    }
  }
  if (method === "observability.networkGet" || method === "observability.networkClear") {
    const tabId = stringParam(payload, "tabId");
    if (tabId === undefined) {
      throw new SnapshotErrorShim("TAB_INVALID_ID", `${method} requires tabId`);
    }
    const limit = payload["limit"];
    if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)) {
      throw new SnapshotErrorShim("OBSERVABILITY_FAILED", `${method} field limit must be a positive integer`);
    }
    const capacity = payload["capacity"];
    if (capacity !== undefined && (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity <= 0)) {
      throw new SnapshotErrorShim("OBSERVABILITY_CONFIG_INVALID", `${method} field capacity must be a positive integer`);
    }
    try {
      return method === "observability.networkGet"
        ? await snapshotManager.getNetwork(
          tabId,
          typeof limit === "number" ? limit : undefined,
          typeof capacity === "number" ? capacity : undefined,
        )
        : await snapshotManager.clearNetwork(tabId);
    } catch (error: unknown) {
      throw toBridgeSnapshotError(error);
    }
  }
  throw new Error(`unknown bridge method ${method}`);
});

bridge.ensureConnected("worker-start");

// MV3 service workers suspend when idle, which kills setTimeout-based
// retry. The repeating alarm below is the wake-safe reconnect safety net
// (1 minute cadence): it retries the connection after MCP
// restarts even when nobody is interacting with the extension. The alarms
// permission exists solely for this reconnect schedule.
const BRIDGE_RETRY_ALARM = "arc-mcp-bridge-retry";

async function ensureRetryAlarm(): Promise<void> {
  // Never rely solely on historical persistence: verify on every startup
  // and recreate when missing. persistAcrossSessions keeps the schedule
  // across browser restarts (Chromium 153 supports it).
  const create = (): Promise<void> =>
    chrome.alarms.create(BRIDGE_RETRY_ALARM, { periodInMinutes: 1, persistAcrossSessions: true });
  try {
    const existing = await chrome.alarms.get(BRIDGE_RETRY_ALARM);
    if (existing === undefined) {
      await create();
    }
  } catch {
    await create();
  }
}

void ensureRetryAlarm();
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BRIDGE_RETRY_ALARM) {
    bridge.ensureConnected("alarm");
  }
});

// Event-driven wake: these fire on real user/browser activity and wake a
// suspended worker immediately, so the bridge reconnects on interaction
// instead of waiting for the next alarm tick. The alarm above stays as the
// safety net for fully idle browsers. ensureConnected is idempotent.
chrome.tabs.onActivated.addListener(() => {
  bridge.ensureConnected("tab-activated");
});
chrome.windows.onFocusChanged.addListener(() => {
  bridge.ensureConnected("window-focus");
});
chrome.runtime.onStartup.addListener(() => {
  bridge.ensureConnected("startup");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isRecord(message)) {
    return false;
  }
  if (message["type"] === "ARC_MCP_RUN_DIAGNOSTICS") {
    if (diagnosticsProgress?.running === true) {
      sendResponse({ ok: false, error: "diagnostics already running" });
      return false;
    }
    const startedAt = new Date().toISOString();
    // Visible synchronously so a freshly opened page polling progress sees
    // the live run before the first check settles; onProgress refines it.
    diagnosticsProgress = {
      running: true,
      currentCheck: "starting",
      capabilities: (diagnosticsProgress?.capabilities ?? {}) as CapabilityMatrix,
      startedAt,
    };
    // Local fixture page: focused, offline, deterministic. External example
    // pages stall when backgrounded, so we open/focus our own status page.
    // Closing the tab afterwards returns focus to the previous tab.
    const fixtureUrl = chrome.runtime.getURL("diagnostic/fixture.html");
    runDiagnostics(api, {
      testUrl: fixtureUrl,
      onProgress: (currentCheck, capabilities) => {
        try {
          diagnosticsProgress = {
            running: true,
            currentCheck,
            capabilities: JSON.parse(JSON.stringify(capabilities)) as CapabilityMatrix,
            startedAt,
          };
        } catch {
          // Best-effort snapshot; the final report is authoritative.
        }
      },
    })
      .then((report) => {
        settleDiagnosticsProgress();
        void chrome.storage.local.set({ [REPORT_STORAGE_KEY]: report }).then(() => sendResponse({ ok: true, report }));
      })
      .catch((error: unknown) => {
        settleDiagnosticsProgress();
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }
  if (message["type"] === "ARC_MCP_GET_DIAGNOSTICS_PROGRESS") {
    sendResponse({ ok: true, progress: diagnosticsProgress });
    return false;
  }
  if (message["type"] === "ARC_MCP_GET_BRIDGE_STATUS") {
    // Any UI interaction wakes the worker: use it as a connect trigger too.
    bridge.ensureConnected("message");
    sendResponse({ ok: true, status: { ...bridge.getStatus(), buildId: __BUILD_ID__ } });
    return false;
  }
  if (message["type"] === "ARC_MCP_GET_REPORT") {    chrome.storage.local
      .get(REPORT_STORAGE_KEY)
      .then((stored) => {
        sendResponse({ ok: true, report: (stored as Record<string, unknown>)[REPORT_STORAGE_KEY] ?? null });
      })
      .catch((error: unknown) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }
  return false;
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

