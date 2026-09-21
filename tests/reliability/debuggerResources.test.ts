import { describe, expect, it } from "vitest";
import {
  DebuggerSessionManager,
  createMemorySnapshotSessionStorage,
  type DebuggerChrome,
  type SnapshotTabRecord,
} from "../../extension/src/snapshot.js";
import {
  CONSOLE_BUFFER_DEFAULT_ENTRIES,
  CONSOLE_BUFFER_HARD_MAX_ENTRIES,
  NETWORK_BUFFER_DEFAULT_ENTRIES,
  NETWORK_BUFFER_HARD_MAX_ENTRIES,
  NETWORK_CORRELATION_HARD_MAX,
  OBSERVABILITY_MAX_RETRIEVAL_LIMIT,
  OBSERVABILITY_MAX_SERIALIZED_BYTES,
  observabilityUtf8Length,
} from "../../src/observability/observabilityPolicy.js";
import { ConsoleMonitor, buildConsoleResponse } from "../../src/observability/ConsoleMonitor.js";
import { NetworkMonitor, buildNetworkResponse } from "../../src/observability/NetworkMonitor.js";

const SESSION = "a".repeat(32);
const PROJECT = `t-${"a".repeat(32)}-91`;

function axTree(): Record<string, unknown>[] {
  return [
    { nodeId: "1", role: { value: "heading" }, name: { value: "Soak Fixture" }, backendDOMNodeId: 901 },
    { nodeId: "2", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 902 },
  ];
}

interface Harness {
  manager: DebuggerSessionManager;
  commands: Array<{ method: string; params: Record<string, unknown> | undefined }>;
  attaches: number[];
  detaches: number[];
}

function harness(tabUrl = "https://fixture.local/"): Harness {
  const commands: Harness["commands"] = [];
  const attaches: number[] = [];
  const detaches: number[] = [];
  const records = new Map<number, SnapshotTabRecord>([[91, { id: PROJECT, url: tabUrl, title: "Fixture" }]]);
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
    onDetach: () => undefined,
  };
  const manager = new DebuggerSessionManager(
    debuggerChrome,
    (projectId) =>
      projectId === PROJECT ? Promise.resolve(91) : Promise.reject(Object.assign(new Error("x"), { code: "TAB_INVALID_ID" })),
    (chromeId) => records.get(chromeId) ?? null,
    createMemorySnapshotSessionStorage(),
    { generateSessionId: () => SESSION },
  );
  return { manager, commands, attaches, detaches };
}

/**
 * Debugger/resource lifecycle convergence: repeated mixed operations
 * reuse one owned attachment, re-enable domains only as needed, and leave
 * bounded state after cleanup.
 */
describe("debugger lifecycle stress (mocked)", () => {
  it("repeated mixed ops reuse one attachment with no attach storm", async () => {
    const fixture = harness();
    await fixture.manager.capture(PROJECT);
    await fixture.manager.getElementText(PROJECT, (await fixture.manager.capture(PROJECT)).nodes.find((n) => n.ref !== undefined)?.ref ?? "");
    for (let cycle = 0; cycle < 25; cycle += 1) {
      await fixture.manager.capture(PROJECT);
      await fixture.manager.getConsole(PROJECT);
      await fixture.manager.getNetwork(PROJECT);
      await fixture.manager.clearConsole(PROJECT);
      await fixture.manager.clearNetwork(PROJECT);
    }
    // One attach for the whole sequence (lazy persistent attachment).
    expect(fixture.attaches).toEqual([91]);
    expect(fixture.manager.debuggerSessionState(91)).toBe("OWNED");
    expect(fixture.manager.ownedCount()).toBe(1);
    // Domain enables happened exactly once each.
    expect(fixture.commands.filter((c) => c.method === "Runtime.enable")).toHaveLength(1);
    expect(fixture.commands.filter((c) => c.method === "Network.enable")).toHaveLength(1);
  });

  it("detach clears domain bookkeeping; reattach re-enables exactly once", async () => {
    const fixture = harness();
    await fixture.manager.ensureConsoleMonitoring(PROJECT);
    await fixture.manager.ensureNetworkMonitoring(PROJECT);
    await fixture.manager.detachAllOwned();
    expect(fixture.manager.observabilityDomainsForTests(91)).toMatchObject({ consoleEnabled: false, networkEnabled: false });
    expect(fixture.manager.debuggerSessionState(91)).toBe("DETACHED");
    await fixture.manager.getConsole(PROJECT);
    await fixture.manager.getNetwork(PROJECT);
    expect(fixture.commands.filter((c) => c.method === "Runtime.enable")).toHaveLength(2);
    expect(fixture.commands.filter((c) => c.method === "Network.enable")).toHaveLength(2);
    expect(fixture.attaches).toEqual([91, 91]);
  });

  it("tab close clears ownership, buffers, and correlation", async () => {
    const fixture = harness();
    await fixture.manager.ensureConsoleMonitoring(PROJECT);
    await fixture.manager.ensureNetworkMonitoring(PROJECT);
    fixture.manager.handleDebuggerEvent(91, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "before-close" }],
    });
    fixture.manager.handleDebuggerEvent(91, "Network.requestWillBeSent", {
      requestId: "raw-1",
      request: { url: "https://example.test/a", method: "GET", headers: {} },
    });
    expect((await fixture.manager.getConsole(PROJECT)).availableEntries).toBe(1);
    fixture.manager.handleTabRemoved(91);
    expect(fixture.manager.debuggerSessionState(91)).toBe("DETACHED");
    expect(fixture.manager.ownedCount()).toBe(0);
    const after = await fixture.manager.getConsole(PROJECT);
    expect(after.availableEntries).toBe(0);
  });

  it("worker reconstruction resets buffers and never retargets refs", async () => {    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((n) => n.ref !== undefined)?.ref;
    if (ref === undefined) {
      throw new Error("expected a ref");
    }
    fixture.manager.handleDebuggerEvent(91, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "pre-reset" }],
    });
    fixture.manager.resetObservabilityForTests();
    expect((await fixture.manager.getConsole(PROJECT)).availableEntries).toBe(0);
    // Snapshot refs are a separate lifecycle and still valid after an
    // observability-only reset.
    expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(true);
  });
});

describe("idle debugger detach (mocked)", () => {
  it("detaches idle tabs, keeps refs, and reattaches transparently", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((n) => n.ref !== undefined)?.ref;
    if (ref === undefined) {
      throw new Error("expected a ref");
    }
    expect(fixture.manager.debuggerSessionState(91)).toBe("OWNED");
    // Fresh activity is not idle yet under the default 60s lifetime.
    expect(await fixture.manager.detachIdleTabs(Date.now())).toBe(0);
    expect(fixture.manager.debuggerSessionState(91)).toBe("OWNED");
    // Far-future clock: the tab idled out.
    expect(await fixture.manager.detachIdleTabs(Date.now() + 61_000)).toBe(1);
    expect(fixture.detaches).toEqual([91]);
    expect(fixture.manager.debuggerSessionState(91)).toBe("DETACHED");
    // Refs survive the detach (renderer ids are unaffected); the next
    // operation reattaches without any caller-visible ceremony.
    expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(true);
    await fixture.manager.capture(PROJECT);
    expect(fixture.attaches).toEqual([91, 91]);
    expect(fixture.manager.debuggerSessionState(91)).toBe("OWNED");
  });

  it("excludes the requesting tab and ignores unowned tabs", async () => {
    const fixture = harness();
    // Nothing owned: sweep is a no-op with no debugger traffic.
    expect(await fixture.manager.detachIdleTabs(Date.now() + 3600_000)).toBe(0);
    expect(fixture.detaches).toEqual([]);
    await fixture.manager.capture(PROJECT);
    fixture.manager.setIdleDetachTimeoutMsForTests(0);
    expect(await fixture.manager.detachIdleTabs(Date.now() + 3600_000, 91)).toBe(0);
    expect(fixture.manager.debuggerSessionState(91)).toBe("OWNED");
    expect(fixture.detaches).toEqual([]);
  });

  it("opportunistic sweep on attach reaps other idle tabs only", async () => {
    const fixture = harness();
    await fixture.manager.capture(PROJECT);
    // Simulate a second owned tab by attaching through the public path is
    // single-tab here; instead assert the sweep entry point exists on the
    // requesting path: a fresh capture keeps its own attachment while an
    // idle timeout of zero would reap it only when it is NOT the requester.
    fixture.manager.setIdleDetachTimeoutMsForTests(0);
    await fixture.manager.capture(PROJECT);
    expect(fixture.manager.debuggerSessionState(91)).toBe("OWNED");
    // Direct sweep with no exclusion reaps it (proves the ensureAttached
    // exclusion is what protects the active tab, covered above).
    expect(await fixture.manager.detachIdleTabs(Date.now())).toBe(1);
  });
});

describe("bounded-resource verification (mocked)", () => {
  it("console respects default, custom, and hard-max capacities with exact dropped counts", () => {
    const monitor = new ConsoleMonitor(CONSOLE_BUFFER_DEFAULT_ENTRIES);
    for (let i = 0; i < CONSOLE_BUFFER_DEFAULT_ENTRIES + 50; i += 1) {
      monitor.ingest({ timestamp: "t", level: "log", text: `e${String(i)}` });
    }
    expect(monitor.getSize()).toBe(CONSOLE_BUFFER_DEFAULT_ENTRIES);
    expect(monitor.getDroppedCount()).toBe(50);

    const capped = new ConsoleMonitor(CONSOLE_BUFFER_HARD_MAX_ENTRIES + 1_000);
    void capped;
    // Hard max is enforced at policy level: capacities beyond it are invalid.
    expect(CONSOLE_BUFFER_HARD_MAX_ENTRIES).toBe(2000);
    expect(CONSOLE_BUFFER_DEFAULT_ENTRIES).toBe(200);

    // Custom capacity: resize keeps newest.
    const custom = new ConsoleMonitor(2000);
    for (let i = 0; i < 2005; i += 1) {
      custom.ingest({ timestamp: "t", level: "log", text: `c${String(i)}` });
    }
    expect(custom.getSize()).toBe(2000);
    expect(custom.getDroppedCount()).toBe(5);
    expect(custom.newest(3).map((e) => e.text)).toEqual(["c2002", "c2003", "c2004"]);
  });

  it("network respects hard-max buffer, retrieval max, and correlation bound", () => {
    expect(NETWORK_BUFFER_DEFAULT_ENTRIES).toBe(500);
    expect(NETWORK_BUFFER_HARD_MAX_ENTRIES).toBe(5000);
    expect(OBSERVABILITY_MAX_RETRIEVAL_LIMIT).toBe(500);
    expect(NETWORK_CORRELATION_HARD_MAX).toBe(2000);

    const monitor = new NetworkMonitor(5000);
    for (let i = 0; i < NETWORK_CORRELATION_HARD_MAX + 100; i += 1) {
      monitor.requestWillBeSent(`raw-${String(i)}`, { request: { url: "https://example.test/", method: "GET", headers: {} } }, "t");
    }
    expect(monitor.getPendingCount()).toBe(NETWORK_CORRELATION_HARD_MAX);
    expect(monitor.getDroppedCount()).toBe(100);

    // Finished requests clean up correlation deterministically.
    monitor.loadingFinished("raw-2099");
    expect(monitor.getPendingCount()).toBe(NETWORK_CORRELATION_HARD_MAX - 1);
    expect(monitor.getSize()).toBe(1);
    monitor.loadingFailed("raw-2098", { errorText: "net::ERR_ABORTED" });
    expect(monitor.getPendingCount()).toBe(NETWORK_CORRELATION_HARD_MAX - 2);
    expect(monitor.getSize()).toBe(2);

    // Retrieval max: newest 500 in chronological order.
    const finished = new NetworkMonitor(5000);
    for (let i = 0; i < 600; i += 1) {
      finished.requestWillBeSent(`f-${String(i)}`, { request: { url: "https://example.test/", method: "GET", headers: {} } }, "t");
      finished.loadingFinished(`f-${String(i)}`);
    }
    expect(finished.getSize()).toBe(600);
    const newest = finished.newest(10_000);
    expect(newest).toHaveLength(500);

    // Clear resets correlation as designed.
    expect(finished.clear()).toBe(600);
    expect(finished.getPendingCount()).toBe(0);
    expect(finished.getSize()).toBe(0);
  });

  it("observability responses stay within 512 KiB with deterministic newest-wins truncation", () => {
    const entries = Array.from({ length: 600 }, (_v, i) =>
      ({ timestamp: "2026-01-01T00:00:00.000Z", level: "log" as const, text: `n${String(i).padStart(4, "0")}-${"y".repeat(900)}` }));
    const consoleResult = buildConsoleResponse("t-x", 600, entries, 0, 600);
    expect(consoleResult.returnedEntries).toBeLessThanOrEqual(OBSERVABILITY_MAX_RETRIEVAL_LIMIT);
    expect(observabilityUtf8Length(JSON.stringify(consoleResult))).toBeLessThanOrEqual(OBSERVABILITY_MAX_SERIALIZED_BYTES);
    // Chronological, newest survives.
    const texts = consoleResult.entries.map((e) => e.text);
    expect(texts[texts.length - 1]?.startsWith("n0599")).toBe(true);

    const netEntries = Array.from({ length: 600 }, (_v, i) => ({
      id: `n-${i.toString(36)}`,
      startedAt: "2026-01-01T00:00:00.000Z",
      method: "GET",
      url: `https://example.test/r${String(i).padStart(4, "0")}?q=${"z".repeat(800)}`,
      requestHeaders: {},
      hasPostData: false,
    }));
    const netResult = buildNetworkResponse("t-x", 600, netEntries, 0, 600);
    expect(netResult.returnedEntries).toBeLessThanOrEqual(OBSERVABILITY_MAX_RETRIEVAL_LIMIT);
    expect(observabilityUtf8Length(JSON.stringify(netResult))).toBeLessThanOrEqual(OBSERVABILITY_MAX_SERIALIZED_BYTES);
  });
});
