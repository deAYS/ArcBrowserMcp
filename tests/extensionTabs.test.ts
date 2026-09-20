import { describe, expect, it } from "vitest";
import type { ChromeTabView, TabsChrome } from "../extension/src/tabs.js";
import {
  TabError,
  TabRegistry,
  createMemoryTombstoneStore,
  generateTabEpoch,
  isControllableUrl,
  parseProjectId,
} from "../extension/src/tabs.js";

const EPOCH_A = "a".repeat(32);
const EPOCH_B = "b".repeat(32);
const pid = (chromeId: number, epoch: string = EPOCH_A): string => `t-${epoch}-${String(chromeId)}`;

interface MockTabs {
  chrome: TabsChrome;
  tabs: Map<number, ChromeTabView>;
  removedLog: number[];
  activatedLog: number[];
  failOnRemove: Set<number>;
}

function mockTabs(initial: Array<{
  id?: number;
  url?: string;
  title?: string;
  active?: boolean;
  pinned?: boolean;
  windowId?: number;
  index?: number;
}>): MockTabs {
  const tabs = new Map<number, ChromeTabView>();
  const listeners = {
    created: [] as Array<(tab: ChromeTabView) => void>,
    removed: [] as Array<(tabId: number) => void>,
    updated: [] as Array<(tabId: number, tab: ChromeTabView) => void>,
    replaced: [] as Array<(added: number, removed: number) => void>,
  };
  let nextId = 100;
  for (const entry of initial) {
    const id = entry.id ?? nextId++;
    tabs.set(id, {
      id,
      url: entry.url ?? "",
      title: entry.title ?? "",
      active: entry.active ?? false,
      pinned: entry.pinned ?? false,
      windowId: entry.windowId ?? 1,
      index: entry.index ?? 0,
    });
  }
  const removedLog: number[] = [];
  const activatedLog: number[] = [];
  const failOnRemove = new Set<number>();
  const mock: MockTabs = {
    chrome: {
      query: () => Promise.resolve([...tabs.values()]),
      create: (properties) => {
        const id = nextId++;
        const tab: ChromeTabView = {
          id,
          url: properties.url ?? "",
          title: "",
          active: properties.active ?? false,
          pinned: false,
          windowId: 1,
          index: tabs.size,
        };
        tabs.set(id, tab);
        return Promise.resolve(tab);
      },
      update: (id, properties) => {
        const tab = tabs.get(id);
        if (tab === undefined) {
          return Promise.reject(new Error(`No tab with id: ${String(id)}`));
        }
        const updated = { ...tab, ...properties };
        tabs.set(id, updated);
        if (properties.active === true) {
          activatedLog.push(id);
        }
        return Promise.resolve(updated);
      },
      get: (id) => {
        const tab = tabs.get(id);
        return tab === undefined ? Promise.reject(new Error("No tab")) : Promise.resolve(tab);
      },
      remove: (id) => {
        if (failOnRemove.has(id) || !tabs.has(id)) {
          return Promise.reject(new Error(`No tab with id: ${String(id)}`));
        }
        tabs.delete(id);
        removedLog.push(id);
        return Promise.resolve();
      },
      goBack: () => Promise.reject(new Error("history testing uses the dedicated navigation suite")),
      goForward: () => Promise.reject(new Error("history testing uses the dedicated navigation suite")),
      reload: () => Promise.reject(new Error("reload testing uses the dedicated navigation suite")),
      onCreated: (listener) => {
        listeners.created.push(listener);
      },
      onRemoved: (listener) => {
        listeners.removed.push(listener);
      },
      onUpdated: (listener) => {
        listeners.updated.push(listener);
      },
      onReplaced: (listener) => {
        listeners.replaced.push(listener);
      },
    },
    tabs,
    removedLog,
    activatedLog,
    failOnRemove,
  };
  return mock;
}

function tabView(overrides: Partial<ChromeTabView> & { id: number }): ChromeTabView {
  return {
    url: "",
    title: "",
    active: false,
    pinned: false,
    windowId: 1,
    index: 0,
    ...overrides,
  };
}

function registryWithEpoch(epoch: string): TabRegistry {
  return new TabRegistry(createMemoryTombstoneStore(), { generateEpoch: () => epoch });
}

describe("tab session epoch", () => {
  it("generates 128-bit hex epochs from cryptographic randomness", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const epoch = generateTabEpoch();
      expect(epoch).toMatch(/^[0-9a-f]{32}$/);
      seen.add(epoch);
    }
    expect(seen.size).toBe(5);
  });

  it("reconstructs identical IDs across worker suspension from session storage", async () => {
    const mock = mockTabs([{ id: 11, url: "https://a.example/" }, { id: 22, url: "https://b.example/" }]);
    const store = createMemoryTombstoneStore();
    const first = new TabRegistry(store, { generateEpoch: () => EPOCH_A });
    expect((await first.list(mock.chrome)).map((tab) => tab.id)).toEqual([pid(11), pid(22)]);
    // Simulate suspension: fresh registry over the same session store.
    const second = new TabRegistry(store, { generateEpoch: () => EPOCH_B });
    expect((await second.list(mock.chrome)).map((tab) => tab.id)).toEqual([pid(11), pid(22)]);
    expect(await second.currentEpoch()).toBe(EPOCH_A);
  });

  it("creates different IDs in a new session and rejects the old epoch", async () => {
    const mock = mockTabs([{ id: 123, url: "https://a.example/" }]);
    const registryA = registryWithEpoch(EPOCH_A);
    const [recordA] = await registryA.list(mock.chrome);
    expect(recordA?.id).toBe(pid(123, EPOCH_A));
    // New extension/browser session: fresh storage, new epoch.
    const registryB = registryWithEpoch(EPOCH_B);
    const [recordB] = await registryB.list(mock.chrome);
    expect(recordB?.id).toBe(pid(123, EPOCH_B));
    expect(recordB?.id).not.toBe(recordA?.id);
    // The old ID must fail closed, never resolving raw Chrome ID 123.
    await expect(registryB.resolve(mock.chrome, pid(123, EPOCH_A))).rejects.toMatchObject({
      code: "TAB_NOT_FOUND",
    });
    // Sanity: the new ID resolves to the live tab.
    expect(await registryB.resolve(mock.chrome, pid(123, EPOCH_B))).toBe(123);
  });

  it("generates a fresh epoch only when storage has none", async () => {
    let generated = 0;
    const store = createMemoryTombstoneStore();
    const first = new TabRegistry(store, {
      generateEpoch: () => {
        generated += 1;
        return EPOCH_A;
      },
    });
    await first.list(mockTabs([]).chrome);
    expect(generated).toBe(1);
    const second = new TabRegistry(store, {
      generateEpoch: () => {
        generated += 1;
        return EPOCH_B;
      },
    });
    expect(await second.currentEpoch()).toBe(EPOCH_A);
    expect(generated).toBe(1);
  });
});

describe("TabRegistry identity", () => {
  it("assigns stable epoch-qualified IDs across repeated lists", async () => {
    const mock = mockTabs([{ id: 11, url: "https://a.example/" }, { id: 22, url: "https://b.example/" }]);
    const registry = registryWithEpoch(EPOCH_A);
    const first = await registry.list(mock.chrome);
    const second = await registry.list(mock.chrome);
    expect(first.map((tab) => tab.id)).toEqual([pid(11), pid(22)]);
    expect(second.map((tab) => tab.id)).toEqual([pid(11), pid(22)]);
  });

  it("never exposes raw numeric IDs in project records", async () => {
    const mock = mockTabs([{ id: 303265229, url: "https://a.example/" }]);
    const registry = registryWithEpoch(EPOCH_A);
    const [tab] = await registry.list(mock.chrome);
    expect(tab?.id).toBe(pid(303265229));
    expect(tab?.id).toMatch(/^t-[0-9a-f]{32}-\d+$/);
    expect(JSON.stringify(tab)).not.toContain('"id":303265229');
  });

  it("replaces invalidates the old ID and maps the replacement fresh (rule B)", async () => {
    const mock = mockTabs([{ id: 11, url: "https://a.example/" }]);
    const registry = registryWithEpoch(EPOCH_A);
    await registry.list(mock.chrome);
    mock.tabs.delete(11);
    mock.tabs.set(12, tabView({ id: 12, url: "https://a.example/" }));
    const listeners: Array<(added: number, removed: number) => void> = [];
    registry.attachListeners({
      onCreated: () => undefined,
      onRemoved: () => undefined,
      onUpdated: () => undefined,
      onReplaced: (listener) => {
        listeners.push(listener);
      },
    });
    for (const listener of listeners) {
      listener(12, 11);
    }
    await expect(registry.resolve(mock.chrome, pid(11))).rejects.toBeInstanceOf(TabError);
    const records = await registry.list(mock.chrome);
    expect(records.map((tab) => tab.id)).toEqual([pid(12)]);
  });

  it("prevents stale-ID retargeting when a numeric ID is reused in-session", async () => {
    const mock = mockTabs([{ id: 11, url: "https://a.example/" }]);
    const registry = registryWithEpoch(EPOCH_A);
    await registry.list(mock.chrome);
    mock.tabs.delete(11);
    await registry.list(mock.chrome);
    mock.tabs.set(11, tabView({ id: 11, url: "https://evil.example/" }));
    const records = await registry.list(mock.chrome);
    expect(records.map((tab) => tab.id)).toEqual([`${pid(11)}-r2`]);
    expect(records[0]?.url).toBe("https://evil.example/");
    await expect(registry.resolve(mock.chrome, pid(11))).rejects.toMatchObject({ code: "TAB_NOT_FOUND" });
    expect(await registry.resolve(mock.chrome, `${pid(11)}-r2`)).toBe(11);
  });

  it("rejects malformed project IDs without touching chrome", async () => {
    const mock = mockTabs([{ id: 11 }]);
    const registry = registryWithEpoch(EPOCH_A);
    let queries = 0;
    const counting = {
      ...mock.chrome,
      query: () => {
        queries += 1;
        return mock.chrome.query({});
      },
    };
    await expect(registry.resolve(counting, "nope")).rejects.toMatchObject({ code: "TAB_INVALID_ID" });
    await expect(registry.resolve(counting, "t-11")).rejects.toMatchObject({ code: "TAB_INVALID_ID" });
    await expect(registry.resolve(counting, `t-xyz-11`)).rejects.toMatchObject({ code: "TAB_INVALID_ID" });
    expect(queries).toBe(0);
  });
});

describe("TabRegistry operations", () => {
  it("opens tabs active and returns records", async () => {
    const mock = mockTabs([]);
    const registry = registryWithEpoch(EPOCH_A);
    const tab = await registry.openTab(mock.chrome, "https://example.com/");
    expect(tab.id).toBe(pid(100));
    expect(tab.url).toBe("https://example.com/");
    expect(mock.tabs.get(100)?.active).toBe(true);
  });

  it("opens a blank tab when no URL is supplied", async () => {
    const mock = mockTabs([]);
    const registry = registryWithEpoch(EPOCH_A);
    const tab = await registry.openTab(mock.chrome, undefined);
    expect(tab.id).toMatch(/^t-[0-9a-f]{32}-\d+$/);
  });

  it("rejects dangerous schemes before touching chrome", async () => {
    const mock = mockTabs([]);
    const registry = registryWithEpoch(EPOCH_A);
    let creates = 0;
    const counting = {
      ...mock.chrome,
      create: () => {
        creates += 1;
        return mock.chrome.create({});
      },
    };
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "chrome://settings", "arc://x", "chrome-extension://abc"]) {
      await expect(registry.openTab(counting, url)).rejects.toMatchObject({ code: "TAB_CREATE_FAILED" });
    }
    expect(creates).toBe(0);
  });

  it("activates through chrome.tabs.update", async () => {
    const mock = mockTabs([{ id: 11 }]);
    const registry = registryWithEpoch(EPOCH_A);
    const record = await registry.activateTab(mock.chrome, pid(11));
    expect(record.id).toBe(pid(11));
    expect(mock.activatedLog).toEqual([11]);
  });

  it("closes and tombstones, then rejects the stale ID", async () => {
    const mock = mockTabs([{ id: 11 }]);
    const registry = registryWithEpoch(EPOCH_A);
    const result = await registry.closeTab(mock.chrome, pid(11));
    expect(result).toEqual({ closed: pid(11) });
    expect(mock.removedLog).toEqual([11]);
    await expect(registry.resolve(mock.chrome, pid(11))).rejects.toMatchObject({ code: "TAB_NOT_FOUND" });
  });

  it("maps close races to typed errors, never silent success", async () => {
    const mock = mockTabs([{ id: 11 }]);
    mock.failOnRemove.add(11);
    const registry = registryWithEpoch(EPOCH_A);
    await expect(registry.closeTab(mock.chrome, pid(11))).rejects.toMatchObject({ code: "TAB_CLOSE_FAILED" });
  });

  it("reconciles externally closed tabs on next list", async () => {
    const mock = mockTabs([{ id: 11 }, { id: 22 }]);
    const registry = registryWithEpoch(EPOCH_A);
    expect((await registry.list(mock.chrome)).map((tab) => tab.id)).toEqual([pid(11), pid(22)]);
    mock.tabs.delete(22);
    expect((await registry.list(mock.chrome)).map((tab) => tab.id)).toEqual([pid(11)]);
    await expect(registry.resolve(mock.chrome, pid(22))).rejects.toMatchObject({ code: "TAB_NOT_FOUND" });
  });

  it("discovers externally opened tabs", async () => {
    const mock = mockTabs([{ id: 11 }]);
    const registry = registryWithEpoch(EPOCH_A);
    await registry.list(mock.chrome);
    mock.tabs.set(99, tabView({ id: 99, url: "https://user.example/" }));
    const records = await registry.list(mock.chrome);
    expect(records.map((tab) => tab.id)).toEqual([pid(11), pid(99)]);
  });
});

describe("controllable classification", () => {
  it.each<[string, boolean]>([
    ["https://example.com/", true],
    ["http://example.com/", true],
    ["", false],
    ["chrome://newtab/", false],
    ["arc://extensions", false],
    ["chrome-extension://abc/page.html", false],
    ["about:blank", false],
    ["devtools://devtools/bundled/inspector.html", false],
  ])("classifies %s as %s", (url, expected) => {
    expect(isControllableUrl(url)).toBe(expected);
  });

  it("parses epoch-qualified project IDs strictly", () => {
    expect(parseProjectId(pid(12))).toEqual({ epoch: EPOCH_A, chromeId: 12, suffix: null });
    expect(parseProjectId(`${pid(12)}-r2`)).toEqual({ epoch: EPOCH_A, chromeId: 12, suffix: 2 });
    expect(parseProjectId("t-12")).toBeNull();
    expect(parseProjectId("12")).toBeNull();
    expect(parseProjectId("t-abc")).toBeNull();
    expect(parseProjectId(`t-${EPOCH_A}`)).toBeNull();
  });
});
