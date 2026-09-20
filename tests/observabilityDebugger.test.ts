import { describe, expect, it } from "vitest";
import {
  DebuggerSessionManager,
  createMemorySnapshotSessionStorage,
  type DebuggerChrome,
  type SnapshotTabRecord,
} from "../extension/src/snapshot.js";
import { CONSOLE_BUFFER_DEFAULT_ENTRIES, NETWORK_BUFFER_DEFAULT_ENTRIES } from "../src/observability/observabilityPolicy.js";

const SESSION = "e".repeat(32);
const PROJECT = `t-${"e".repeat(32)}-61`;

function axTree(): Record<string, unknown>[] {
  return [
    { nodeId: "1", role: { value: "heading" }, name: { value: "P09 Fixture" }, backendDOMNodeId: 601, childIds: ["2"] },
    { nodeId: "2", role: { value: "link" }, name: { value: "More" }, backendDOMNodeId: 602 },
  ];
}

interface Harness {
  manager: DebuggerSessionManager;
  commands: Array<{ method: string; params: Record<string, unknown> | undefined }>;
  attaches: number[];
  detaches: number[];
  detachListeners: Array<(tabId: number | undefined, reason: string) => void>;
  records: Map<number, SnapshotTabRecord>;
}

function harness(tabUrl = "https://fixture.local/"): Harness {
  const commands: Harness["commands"] = [];
  const attaches: number[] = [];
  const detaches: number[] = [];
  const detachListeners: Harness["detachListeners"] = [];
  const records = new Map<number, SnapshotTabRecord>([[61, { id: PROJECT, url: tabUrl, title: "Fixture" }]]);
  const debuggerChrome: DebuggerChrome = {
    attach: (tabId) => {
      attaches.push(tabId);
      return Promise.resolve();
    },
    sendCommand: (_tabId, method, params) => {
      commands.push({ method, params });
      if (method === "Accessibility.getFullAXTree") {
        return Promise.resolve({ nodes: axTree() });
      }
      return Promise.resolve({});
    },
    detach: (tabId) => {
      detaches.push(tabId);
      return Promise.resolve();
    },
    onDetach: (listener) => {
      detachListeners.push(listener);
    },
  };
  const manager = new DebuggerSessionManager(
    debuggerChrome,
    (projectId) =>
      projectId === PROJECT ? Promise.resolve(61) : Promise.reject(Object.assign(new Error("x"), { code: "TAB_INVALID_ID" })),
    (chromeId) => records.get(chromeId) ?? null,
    createMemorySnapshotSessionStorage(),
    { generateSessionId: () => SESSION },
  );
  return { manager, commands, attaches, detaches, detachListeners, records };
}

function enableMethods(commands: Harness["commands"]): string[] {
  return commands.map((command) => command.method);
}

describe("P09 debugger/lifecycle: console monitoring", () => {
  it("first get attaches safely + Runtime.enable; repeat does not re-enable", async () => {
    const fixture = harness();
    const first = await fixture.manager.getConsole(PROJECT);
    expect(first.monitoring).toBe(true);
    expect(first.tabId).toBe(PROJECT);
    expect(first.capacity).toBe(CONSOLE_BUFFER_DEFAULT_ENTRIES);
    expect(fixture.attaches).toEqual([61]);
    expect(enableMethods(fixture.commands)).toContain("Runtime.enable");
    const enables = fixture.commands.filter((c) => c.method === "Runtime.enable").length;
    await fixture.manager.getConsole(PROJECT);
    expect(fixture.commands.filter((c) => c.method === "Runtime.enable")).toHaveLength(enables);
  });

  it("debugger detach marks domains disabled; later get re-enables", async () => {
    const fixture = harness();
    await fixture.manager.getConsole(PROJECT);
    expect(fixture.manager.observabilityDomainsForTests(61)).toMatchObject({ consoleEnabled: true });
    for (const listener of fixture.detachListeners) {
      listener(61, "replaced_with_devtools");
    }
    expect(fixture.manager.observabilityDomainsForTests(61)).toMatchObject({ consoleEnabled: false });
    const after = await fixture.manager.getConsole(PROJECT);
    expect(after.monitoring).toBe(true);
    expect(fixture.manager.observabilityDomainsForTests(61)).toMatchObject({ consoleEnabled: true });
    // Reattach happened exactly once more (lazy, not a steal).
    expect(fixture.attaches).toEqual([61, 61]);
  });

  it("UNCERTAIN fails observability with DEBUGGER_UNAVAILABLE", async () => {
    // Genuine UNCERTAIN via the evaluate-retirement path with a failing
    // detach (same mechanism as extensionPageTools retirement tests).
    const records = new Map<number, SnapshotTabRecord>([[61, { id: PROJECT, url: "https://fixture.local/", title: "F" }]]);
    let hanging = false;
    const chrome: DebuggerChrome = {
      attach: () => Promise.resolve(),
      sendCommand: (_t, method) => {
        if (method === "Runtime.evaluate" && hanging) {
          return new Promise<Record<string, unknown>>(() => undefined);
        }
        return Promise.resolve({});
      },
      detach: () => Promise.reject(new Error("detach boom")),
      onDetach: () => undefined,
    };
    const manager = new DebuggerSessionManager(
      chrome,
      (projectId) => (projectId === PROJECT ? Promise.resolve(61) : Promise.reject(Object.assign(new Error("x"), { code: "TAB_INVALID_ID" }))),
      (chromeId) => records.get(chromeId) ?? null,
      createMemorySnapshotSessionStorage(),
      { generateSessionId: () => SESSION },
    );
    manager.setRetireDetachTimeoutMsForTests(1_000);
    await manager.ensureConsoleMonitoring(PROJECT);
    hanging = true;
    await expect(manager.evaluateElement(PROJECT, "never", 20)).rejects.toMatchObject({ code: "EVALUATION_TIMEOUT" });
    expect(manager.debuggerSessionState(61)).toBe("UNCERTAIN");
    const enablesBefore = 1;
    void enablesBefore;
    await expect(manager.getConsole(PROJECT)).rejects.toMatchObject({ code: "DEBUGGER_UNAVAILABLE" });
    await expect(manager.getNetwork(PROJECT)).rejects.toMatchObject({ code: "DEBUGGER_UNAVAILABLE" });
    await expect(manager.clearConsole(PROJECT)).rejects.toMatchObject({ code: "DEBUGGER_UNAVAILABLE" });
    await expect(manager.clearNetwork(PROJECT)).rejects.toMatchObject({ code: "DEBUGGER_UNAVAILABLE" });
    // Events in UNCERTAIN are dropped, never stored.
    manager.handleDebuggerEvent(61, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "uncertain-marker" }],
    });
    // Still uncertain afterwards (no silent recovery).
    expect(manager.debuggerSessionState(61)).toBe("UNCERTAIN");
  });

  it("foreign debugger conflict never detaches", async () => {
    const commands: Array<{ method: string }> = [];
    let detaches = 0;
    const records = new Map<number, SnapshotTabRecord>([[61, { id: PROJECT, url: "https://fixture.local/", title: "F" }]]);
    const foreign: DebuggerChrome = {
      attach: () => Promise.reject(new Error("another debugger is already attached")),
      sendCommand: (_t, method) => {
        commands.push({ method });
        return Promise.resolve({});
      },
      detach: () => {
        detaches += 1;
        return Promise.resolve();
      },
      onDetach: () => undefined,
    };
    const manager = new DebuggerSessionManager(
      foreign,
      (projectId) => (projectId === PROJECT ? Promise.resolve(61) : Promise.reject(Object.assign(new Error("x"), { code: "TAB_INVALID_ID" }))),
      (chromeId) => records.get(chromeId) ?? null,
      createMemorySnapshotSessionStorage(),
      { generateSessionId: () => SESSION },
    );
    await expect(manager.getConsole(PROJECT)).rejects.toMatchObject({ code: "DEBUGGER_UNAVAILABLE" });
    await expect(manager.getNetwork(PROJECT)).rejects.toMatchObject({ code: "DEBUGGER_UNAVAILABLE" });
    expect(detaches).toBe(0);
  });

  it("privileged tab rejected pre-enable with zero debugger traffic", async () => {
    const fixture = harness("chrome://newtab/");
    await expect(fixture.manager.getConsole(PROJECT)).rejects.toMatchObject({ code: "TAB_NOT_CONTROLLABLE" });
    await expect(fixture.manager.getNetwork(PROJECT)).rejects.toMatchObject({ code: "TAB_NOT_CONTROLLABLE" });
    expect(fixture.commands).toHaveLength(0);
    expect(fixture.attaches).toHaveLength(0);
  });

  it("tab close clears buffers, maps, and domains", async () => {
    const fixture = harness();
    await fixture.manager.ensureConsoleMonitoring(PROJECT);
    fixture.manager.handleDebuggerEvent(61, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "before-close" }],
    });
    expect((await fixture.manager.getConsole(PROJECT)).availableEntries).toBe(1);
    fixture.manager.handleTabRemoved(61);
    // Fresh state after close: get re-arms on the (possibly reused) tab with
    // an empty buffer rather than serving pre-close observations.
    const after = await fixture.manager.getConsole(PROJECT);
    expect(after.availableEntries).toBe(0);
  });

  it("observability reads/clears do not invalidate element refs", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "heading")?.ref;
    if (ref === undefined) {
      throw new Error("expected a heading ref");
    }
    await fixture.manager.getConsole(PROJECT);
    await fixture.manager.getNetwork(PROJECT);
    await fixture.manager.clearConsole(PROJECT);
    await fixture.manager.clearNetwork(PROJECT);
    expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(true);
  });

  it("clear resets dropped counts without touching the page", async () => {
    const fixture = harness();
    fixture.manager.setObservabilityCapacitiesForTests(2, 2);
    await fixture.manager.ensureConsoleMonitoring(PROJECT);
    for (let index = 0; index < 4; index += 1) {
      fixture.manager.handleDebuggerEvent(61, "Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: `m${String(index)}` }],
      });
    }
    const before = await fixture.manager.getConsole(PROJECT);
    expect(before.droppedCount).toBe(2);
    const cleared = await fixture.manager.clearConsole(PROJECT);
    expect(cleared).toMatchObject({ cleared: true, removedEntries: 2, monitoring: true });
    const after = await fixture.manager.getConsole(PROJECT);
    expect(after.availableEntries).toBe(0);
    expect(after.droppedCount).toBe(0);
    expect(fixture.commands.map((c) => c.method)).not.toContain("Page.navigate");
  });

  it("worker-instance reset starts empty", async () => {
    const fixture = harness();
    await fixture.manager.ensureConsoleMonitoring(PROJECT);
    fixture.manager.handleDebuggerEvent(61, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "x" }],
    });
    fixture.manager.resetObservabilityForTests();
    expect((await fixture.manager.getConsole(PROJECT)).availableEntries).toBe(0);
  });

  it("detachAllOwned clears domains so re-enable re-arms monitoring", async () => {
    const fixture = harness();
    await fixture.manager.ensureConsoleMonitoring(PROJECT);
    await fixture.manager.ensureNetworkMonitoring(PROJECT);
    expect(fixture.manager.observabilityDomainsForTests(61)).toMatchObject({ consoleEnabled: true, networkEnabled: true });
    await fixture.manager.detachAllOwned();
    expect(fixture.manager.observabilityDomainsForTests(61)).toMatchObject({ consoleEnabled: false, networkEnabled: false });
    const consoleEnablesBefore = fixture.commands.filter((c) => c.method === "Runtime.enable").length;
    const networkEnablesBefore = fixture.commands.filter((c) => c.method === "Network.enable").length;
    await fixture.manager.getConsole(PROJECT);
    await fixture.manager.getNetwork(PROJECT);
    expect(fixture.commands.filter((c) => c.method === "Runtime.enable").length).toBe(consoleEnablesBefore + 1);
    expect(fixture.commands.filter((c) => c.method === "Network.enable").length).toBe(networkEnablesBefore + 1);
  });
});

describe("P09 debugger/lifecycle: network monitoring", () => {
  it("first get attaches safely + Network.enable; repeat does not re-enable", async () => {
    const fixture = harness();
    const first = await fixture.manager.getNetwork(PROJECT);
    expect(first.monitoring).toBe(true);
    expect(first.capacity).toBe(NETWORK_BUFFER_DEFAULT_ENTRIES);
    expect(fixture.attaches).toEqual([61]);
    expect(enableMethods(fixture.commands)).toContain("Network.enable");
    const enables = fixture.commands.filter((c) => c.method === "Network.enable").length;
    await fixture.manager.getNetwork(PROJECT);
    expect(fixture.commands.filter((c) => c.method === "Network.enable")).toHaveLength(enables);
  });

  it("RETIRING serializes observability behind retirement", async () => {
    let detachListener: ((tabId: number | undefined, reason: string) => void) | undefined;
    const commands: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
    let detachCalls = 0;
    let releaseDetach: ((value: void | PromiseLike<void>) => void) | undefined;
    const records = new Map<number, SnapshotTabRecord>([[61, { id: PROJECT, url: "https://fixture.local/", title: "F" }]]);
    const chrome: DebuggerChrome = {
      attach: () => Promise.resolve(),
      sendCommand: (_t, method, params) => {
        commands.push({ method, params });
        if (method === "Runtime.evaluate") {
          return new Promise<Record<string, unknown>>(() => undefined);
        }
        if (method === "Accessibility.getFullAXTree") {
          return Promise.resolve({ nodes: axTree() });
        }
        return Promise.resolve({});
      },
      detach: () => {
        detachCalls += 1;
        return new Promise<void>((resolve) => {
          releaseDetach = resolve;
        });
      },
      onDetach: (listener) => {
        detachListener = listener;
      },
    };
    const manager = new DebuggerSessionManager(
      chrome,
      (projectId) => (projectId === PROJECT ? Promise.resolve(61) : Promise.reject(Object.assign(new Error("x"), { code: "TAB_INVALID_ID" }))),
      (chromeId) => records.get(chromeId) ?? null,
      createMemorySnapshotSessionStorage(),
      { generateSessionId: () => SESSION },
    );
    manager.setRetireDetachTimeoutMsForTests(5_000);
    // Attach first so the timeout retires a positively-owned session (the
    // P08 onDetach-during-retirement precedent). Without a prior attach the
    // evaluate path never owns the session and no retirement occurs.
    await manager.ensureConsoleMonitoring(PROJECT);
    expect(manager.debuggerSessionState(61)).toBe("OWNED");
    const pending = manager.evaluateElement(PROJECT, "never", 20);
    const failing = expect(pending).rejects.toMatchObject({ code: "EVALUATION_TIMEOUT" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(manager.debuggerSessionState(61)).toBe("RETIRING");
    // Observability during RETIRING serializes (does not race the detach):
    // the get blocks on the retirement waiter, then reattaches cleanly.
    const observed = manager.getConsole(PROJECT);
    void detachListener;
    void commands;
    if (releaseDetach !== undefined) {
      releaseDetach();
    }
    await failing;
    await observed;
    expect(detachCalls).toBe(1);
    await manager.waitForRetirement(61).catch(() => undefined);
    expect(manager.debuggerSessionState(61)).toBe("OWNED");
  });
});
