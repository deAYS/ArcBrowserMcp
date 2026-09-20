import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import type { BridgeTransportMethod } from "../src/browser/extension/BridgeRuntime.js";
import { BridgeRuntime } from "../src/browser/extension/BridgeRuntime.js";
import { ArcExtensionEngine } from "../src/browser/extension/ArcExtensionEngine.js";
import { ArcError } from "../src/errors/ArcError.js";
import {
  CONSOLE_BUFFER_DEFAULT_ENTRIES,
  NETWORK_BUFFER_DEFAULT_ENTRIES,
  OBSERVABILITY_MAX_SERIALIZED_BYTES,
  observabilityUtf8Length,
} from "../src/observability/observabilityPolicy.js";
import type { BrowserTab } from "../src/browser/models.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const TAB_A = `t-${"d".repeat(32)}-71`;

const CONSOLE_SENTINEL = `p09-engine-console-${"a1".repeat(8)}`;
const NETWORK_SENTINEL = `p09-engine-network-${"b2".repeat(8)}`;

function makeRecord(id: string, overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id,
    title: "P09 Fixture",
    url: "https://fixture.local/",
    active: true,
    pinned: false,
    windowId: 1,
    controllable: true,
    ...overrides,
  };
}

class FakeObservabilityRuntime extends BridgeRuntime {
  relayConnected = true;
  requests: Array<{ method: string; payload: Record<string, unknown> }> = [];
  failNext: BridgeError | null = null;
  tabs = new Map<string, BrowserTab>([[TAB_A, makeRecord(TAB_A)]]);
  selected: string | null = null;

  constructor() {
    super({ pipeName: "\\\\.\\pipe\\arc-mcp-fake-observability", sessionDir: "C:\\arc-mcp-fake-observability" });
  }

  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
  override isRelayConnected(): boolean {
    return this.relayConnected;
  }
  override onRelayChange(): () => void {
    return () => undefined;
  }

  override async request(method: BridgeTransportMethod, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (method !== "tabs.list") {
      this.requests.push({ method, payload });
    }
    if (method !== "tabs.list" && this.failNext !== null) {
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
    if (method === "tabs.activate") {
      const found = this.tabs.get(String(payload["tabId"]));
      if (found === undefined) {
        throw new BridgeError("INVALID_ENVELOPE", "gone", { remoteCode: "TAB_NOT_FOUND" });
      }
      this.selected = found.id;
      return { tab: found };
    }
    if (method === "observability.consoleGet") {
      return {
        tabId: TAB_A,
        monitoring: true,
        capacity: CONSOLE_BUFFER_DEFAULT_ENTRIES,
        availableEntries: 1,
        returnedEntries: 1,
        droppedCount: 0,
        truncated: false,
        entries: [{ timestamp: "2026-01-01T00:00:00.000Z", level: "log", text: "hello console" }],
      };
    }
    if (method === "observability.consoleClear") {
      return { cleared: true, removedEntries: 1, monitoring: true };
    }
    if (method === "observability.networkGet") {
      return {
        tabId: TAB_A,
        monitoring: true,
        capacity: NETWORK_BUFFER_DEFAULT_ENTRIES,
        availableEntries: 1,
        returnedEntries: 1,
        droppedCount: 0,
        truncated: false,
        entries: [
          {
            id: "n-1",
            startedAt: "2026-01-01T00:00:00.000Z",
            method: "GET",
            url: "https://fixture.local/api?page=2",
            requestHeaders: {},
            hasPostData: false,
            status: 200,
          },
        ],
      };
    }
    if (method === "observability.networkClear") {
      return { cleared: true, removedEntries: 1, monitoring: true };
    }
    if (method === "bridge.status") {
      return { connected: true };
    }
    throw new BridgeError("INVALID_ENVELOPE", `unexpected method ${method}`);
  }
}

function harness(options: { consoleBufferEntries?: number; networkBufferEntries?: number } = {}): {
  engine: ArcExtensionEngine;
  runtime: FakeObservabilityRuntime;
} {
  const runtime = new FakeObservabilityRuntime();
  const engine = new ArcExtensionEngine({
    runtime,
    extensionId: EXTENSION_ID,
    connectTimeoutMs: 2_000,
    checkPrerequisites: () => Promise.resolve([]),
    ...options,
  });
  return { engine, runtime };
}

async function connectSelected(options: Parameters<typeof harness>[0] = {}): Promise<{
  engine: ArcExtensionEngine;
  runtime: FakeObservabilityRuntime;
}> {
  const h = harness(options);
  await h.engine.connect();
  await h.engine.selectTab(TAB_A);
  h.runtime.requests.length = 0;
  return h;
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

describe("engine observability gating and mapping", () => {
  it("requires a selected tab with no bridge traffic", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    runtime.requests.length = 0;
    expect(await catchCode(() => engine.getConsole())).toBe("BROWSER_NO_SELECTED_TAB");
    expect(await catchCode(() => engine.clearConsole())).toBe("BROWSER_NO_SELECTED_TAB");
    expect(await catchCode(() => engine.getNetwork())).toBe("BROWSER_NO_SELECTED_TAB");
    expect(await catchCode(() => engine.clearNetwork())).toBe("BROWSER_NO_SELECTED_TAB");
    expect(runtime.requests).toHaveLength(0);
  });

  it("rejects privileged tabs before any observability traffic", async () => {
    const { engine, runtime } = await connectSelected();
    runtime.tabs.set(TAB_A, makeRecord(TAB_A, { url: "chrome://newtab/", controllable: false }));
    const before = runtime.requests.length;
    expect(await catchCode(() => engine.getConsole())).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
    expect(await catchCode(() => engine.getNetwork())).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
    expect(runtime.requests.length).toBe(before);
  });

  it("rejects invalid limits and invalid buffer config before dispatch", async () => {
    const { engine, runtime } = await connectSelected();
    expect(await catchCode(() => engine.getConsole(0))).toBe("BROWSER_OBSERVABILITY_FAILED");
    expect(await catchCode(() => engine.getNetwork(501))).toBe("BROWSER_OBSERVABILITY_FAILED");
    expect(runtime.requests.filter((r) => r.method.startsWith("observability."))).toHaveLength(0);
    const bad = harness({ consoleBufferEntries: 0 });
    await bad.engine.connect();
    await bad.engine.selectTab(TAB_A);
    expect(await catchCode(() => bad.engine.getConsole())).toBe("BROWSER_OBSERVABILITY_CONFIG_INVALID");
  });

  it("returns bounded get/clear shapes with explicit typed RPCs", async () => {
    const { engine, runtime } = await connectSelected();
    const consoleResult = await engine.getConsole();
    expect(consoleResult).toMatchObject({ tabId: TAB_A, monitoring: true, returnedEntries: 1 });
    const consoleClear = await engine.clearConsole();
    expect(consoleClear).toEqual({ cleared: true, removedEntries: 1, monitoring: true });
    const networkResult = await engine.getNetwork();
    expect(networkResult).toMatchObject({ tabId: TAB_A, monitoring: true, returnedEntries: 1 });
    const networkClear = await engine.clearNetwork();
    expect(networkClear).toEqual({ cleared: true, removedEntries: 1, monitoring: true });
    const methods = runtime.requests.map((r) => r.method);
    for (const method of [
      "observability.consoleGet",
      "observability.consoleClear",
      "observability.networkGet",
      "observability.networkClear",
    ]) {
      expect(methods).toContain(method);
    }
    // Payloads carry only tabId/limit/capacity: no bodies, no payloads.
    for (const request of runtime.requests.filter((r) => r.method.startsWith("observability."))) {
      for (const key of Object.keys(request.payload)) {
        expect(["tabId", "limit", "capacity"]).toContain(key);
      }
    }
  });

  it("honors the retrieval limit parameter", async () => {
    const { engine, runtime } = await connectSelected();
    await engine.getConsole(10);
    const get = runtime.requests.find((r) => r.method === "observability.consoleGet");
    expect(get?.payload["limit"]).toBe(10);
    await engine.getNetwork(7);
    const netGet = runtime.requests.find((r) => r.method === "observability.networkGet");
    expect(netGet?.payload["limit"]).toBe(7);
  });

  it("maps debugger conflicts and gone tabs without retargeting", async () => {
    const { engine, runtime } = await connectSelected();
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "busy", { remoteCode: "DEBUGGER_UNAVAILABLE" });
    expect(await catchCode(() => engine.getConsole())).toBe("BROWSER_DEBUGGER_UNAVAILABLE");
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "gone", { remoteCode: "TAB_NOT_FOUND" });
    expect(await catchCode(() => engine.getNetwork())).toBe("BROWSER_TAB_NOT_FOUND");
  });

  it("defense-in-depth: raw sentinel headers/URLs never survive engine output", async () => {
    const { engine, runtime } = await connectSelected();
    runtime.tabs.set(TAB_A, makeRecord(TAB_A));
    // Override the runtime for this test: return hostile-but-shaped payloads.
    const hostile = runtime.request.bind(runtime);
    runtime.request = (async (method: BridgeTransportMethod, payload: Record<string, unknown> = {}) => {
      const result = (await hostile(method, payload)) as Record<string, unknown>;
      if (method === "observability.consoleGet") {
        return { ...result, entries: [{ timestamp: "t", level: "log", text: `Bearer ${CONSOLE_SENTINEL}` }] };
      }
      if (method === "observability.networkGet") {
        return {
          ...result,
          entries: [
            {
              id: "n-1",
              startedAt: "t",
              method: "GET",
              url: `https://example.test/?token=${NETWORK_SENTINEL}`,
              requestHeaders: { Authorization: NETWORK_SENTINEL },
              hasPostData: false,
            },
          ],
        };
      }
      return result;
    }) as FakeObservabilityRuntime["request"];
    const consoleResult = await engine.getConsole();
    expect(JSON.stringify(consoleResult)).not.toContain(CONSOLE_SENTINEL);
    const networkResult = await engine.getNetwork();
    const serialized = JSON.stringify(networkResult);
    expect(serialized).not.toContain(NETWORK_SENTINEL);
    expect(networkResult.entries[0]?.requestHeaders["Authorization"]).toBe("[REDACTED]");
    expect(observabilityUtf8Length(serialized)).toBeLessThanOrEqual(OBSERVABILITY_MAX_SERIALIZED_BYTES);
  });
});
