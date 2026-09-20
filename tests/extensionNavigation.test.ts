import { describe, expect, it } from "vitest";
import type { ChromeTabView, TabsChrome } from "../extension/src/tabs.js";
import { TabRegistry, createMemoryTombstoneStore } from "../extension/src/tabs.js";
import { validateNavigationUrl } from "../src/browser/navigationPolicy.js";

function chromeTab(id: number, url: string): ChromeTabView {
  return { id, url, title: "", active: true, pinned: false, windowId: 1, index: 0 };
}

interface MockNav {
  chrome: TabsChrome;
  updatedUrls: string[];
  reloaded: Array<{ tabId: number; bypassCache: boolean | undefined }>;
  backs: number[];
  forwards: number[];
  failNext(error: Error): void;
}

function mockNav(initialUrl: string): MockNav {
  const tabs = new Map<number, ChromeTabView>([[11, chromeTab(11, initialUrl)]]);
  const updatedUrls: string[] = [];
  const reloaded: Array<{ tabId: number; bypassCache: boolean | undefined }> = [];
  const backs: number[] = [];
  const forwards: number[] = [];
  const failures: { next: Error | null } = { next: null };
  const mock: MockNav = {
    updatedUrls,
    reloaded,
    backs,
    forwards,
    failNext: (error: Error) => {
      failures.next = error;
    },
    chrome: {
      query: () => Promise.resolve([...tabs.values()]),
      create: (properties) => {
        const tab = chromeTab(99, properties.url ?? "");
        tabs.set(99, tab);
        return Promise.resolve(tab);
      },
      update: (id, properties) => {
        if (failures.next !== null) {
          const failure = failures.next;
          failures.next = null;
          return Promise.reject(failure);
        }
        const tab = tabs.get(id);
        if (tab === undefined) {
          return Promise.reject(new Error("No tab"));
        }
        if (properties.url !== undefined) {
          updatedUrls.push(properties.url);
        }
        const updated = { ...tab, ...properties };
        tabs.set(id, updated);
        return Promise.resolve(updated);
      },
      get: (id) => {
        const tab = tabs.get(id);
        return tab === undefined ? Promise.reject(new Error("No tab")) : Promise.resolve(tab);
      },
      remove: (id) => {
        tabs.delete(id);
        return Promise.resolve();
      },
      goBack: (id) => {
        if (failures.next !== null) {
          const failure = failures.next;
          failures.next = null;
          return Promise.reject(failure);
        }
        backs.push(id);
        tabs.set(id, { ...chromeTab(id, initialUrl), url: "https://example.com/back" });
        return Promise.resolve();
      },
      goForward: (id) => {
        if (failures.next !== null) {
          const failure = failures.next;
          failures.next = null;
          return Promise.reject(failure);
        }
        forwards.push(id);
        return Promise.resolve();
      },
      reload: (id, bypassCache) => {
        reloaded.push({ tabId: id, bypassCache });
        return Promise.resolve();
      },
      onCreated: () => undefined,
      onRemoved: () => undefined,
      onUpdated: () => undefined,
      onReplaced: () => undefined,
    },
  };
  return mock;
}

async function projectId(mock: MockNav): Promise<string> {
  const registry = new TabRegistry(createMemoryTombstoneStore(), { generateEpoch: () => "a".repeat(32) });
  const records = await registry.list(mock.chrome);
  const id = records[0]?.id;
  if (id === undefined) {
    throw new Error("no tab");
  }
  return id;
}

describe("extension navigation handlers", () => {
  it("navigates via tabs.update and preserves TabId", async () => {
    const mock = mockNav("https://example.com/");
    const registry = new (await import("../extension/src/tabs.js")).TabRegistry(
      createMemoryTombstoneStore(),
      { generateEpoch: () => "a".repeat(32) },
    );
    const id = await projectId(mock);
    const record = await registry.navigateTab(mock.chrome, id, "https://example.com/next", validateNavigationUrl);
    expect(record.id).toBe(id);
    expect(record.url).toBe("https://example.com/next");
    expect(mock.updatedUrls).toEqual(["https://example.com/next"]);
  });

  it("rejects privileged source tabs before touching chrome", async () => {
    const mock = mockNav("chrome://extensions/");
    const registry = new (await import("../extension/src/tabs.js")).TabRegistry(
      createMemoryTombstoneStore(),
      { generateEpoch: () => "a".repeat(32) },
    );
    const id = await projectId(mock);
    let caught: unknown = null;
    try {
      await registry.navigateTab(mock.chrome, id, "https://example.com/", validateNavigationUrl);
    } catch (error: unknown) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("TAB_NOT_CONTROLLABLE");
    expect(mock.updatedUrls).toEqual([]);
  });

  it("allows about:blank sources", async () => {
    const mock = mockNav("about:blank");
    const registry = new (await import("../extension/src/tabs.js")).TabRegistry(
      createMemoryTombstoneStore(),
      { generateEpoch: () => "a".repeat(32) },
    );
    const id = await projectId(mock);
    const record = await registry.navigateTab(mock.chrome, id, "https://example.com/", validateNavigationUrl);
    expect(record.url).toBe("https://example.com/");
  });

  it("never calls tabs.update for invalid destinations", async () => {
    const mock = mockNav("https://example.com/");
    const registry = new (await import("../extension/src/tabs.js")).TabRegistry(
      createMemoryTombstoneStore(),
      { generateEpoch: () => "a".repeat(32) },
    );
    const id = await projectId(mock);
    await expect(
      registry.navigateTab(mock.chrome, id, "javascript:alert(1)", validateNavigationUrl),
    ).rejects.toMatchObject({ code: "TAB_URL_NOT_ALLOWED" });
    expect(mock.updatedUrls).toEqual([]);
  });

  it("maps Chrome navigation rejection to TAB_NAVIGATION_FAILED", async () => {
    const mock = mockNav("https://example.com/");
    mock.failNext(new Error("No tab with id: 11"));
    const registry = new (await import("../extension/src/tabs.js")).TabRegistry(
      createMemoryTombstoneStore(),
      { generateEpoch: () => "a".repeat(32) },
    );
    const id = await projectId(mock);
    await expect(
      registry.navigateTab(mock.chrome, id, "https://example.com/x", validateNavigationUrl),
    ).rejects.toMatchObject({ code: "TAB_NAVIGATION_FAILED" });
  });

  it("goBack/goForward/reload preserve TabId and map bypassCache", async () => {
    const mock = mockNav("https://example.com/");
    const { TabRegistry: Registry } = await import("../extension/src/tabs.js");
    const registry = new Registry(createMemoryTombstoneStore(), { generateEpoch: () => "a".repeat(32) });
    const id = await projectId(mock);
    const back = await registry.goBackTab(mock.chrome, id);
    expect(back.id).toBe(id);
    expect(mock.backs).toEqual([11]);
    const forward = await registry.goForwardTab(mock.chrome, id);
    expect(forward.id).toBe(id);
    expect(mock.forwards).toEqual([11]);
    const reloaded = await registry.reloadTab(mock.chrome, id, true);
    expect(reloaded.id).toBe(id);
    expect(mock.reloaded).toEqual([{ tabId: 11, bypassCache: true }]);
    const reloadedPlain = await registry.reloadTab(mock.chrome, id, false);
    expect(reloadedPlain.id).toBe(id);
    expect(mock.reloaded[1]).toEqual({ tabId: 11, bypassCache: false });
  });

  it("maps history failures to TAB_HISTORY_UNAVAILABLE", async () => {
    const mock = mockNav("https://example.com/");
    mock.failNext(new Error("No history"));
    const { TabRegistry: Registry } = await import("../extension/src/tabs.js");
    const registry = new Registry(createMemoryTombstoneStore(), { generateEpoch: () => "a".repeat(32) });
    const id = await projectId(mock);
    await expect(registry.goBackTab(mock.chrome, id)).rejects.toMatchObject({ code: "TAB_HISTORY_UNAVAILABLE" });
    mock.failNext(new Error("No history"));
    await expect(registry.goForwardTab(mock.chrome, id)).rejects.toMatchObject({ code: "TAB_HISTORY_UNAVAILABLE" });
  });

  it("stale and foreign-epoch IDs never reach Chrome beyond registry behavior", async () => {
    const mock = mockNav("https://example.com/");
    const { TabRegistry: Registry } = await import("../extension/src/tabs.js");
    const registry = new Registry(createMemoryTombstoneStore(), { generateEpoch: () => "a".repeat(32) });
    const id = await projectId(mock);
    mock.chrome.query = () => Promise.resolve([]);
    await expect(registry.navigateTab(mock.chrome, id, "https://example.com/", validateNavigationUrl)).rejects.toMatchObject({
      code: "TAB_NOT_FOUND",
    });
    expect(mock.updatedUrls).toEqual([]);
  });
});


