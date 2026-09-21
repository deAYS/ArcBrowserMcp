import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import type { BridgeTransportMethod } from "../src/browser/extension/BridgeRuntime.js";
import { BridgeRuntime } from "../src/browser/extension/BridgeRuntime.js";

import { arcSpec } from "../src/browser/chromium/spec.js";
import { ExtensionEngine } from "../src/browser/extension/ExtensionEngine.js";
import { BrowserService } from "../src/browser/BrowserService.js";
import { BrowserError } from "../src/errors/BrowserError.js";
import { findLeakedCdpKeys } from "../src/browser/snapshotSemantics.js";
import type { BrowserTab } from "../src/browser/models.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const TAB_A = `t-${"a".repeat(32)}-11`;

function makeRecord(id: string, overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id,
    title: overrides.title ?? "Example Domain",
    url: overrides.url ?? "https://example.com/",
    active: overrides.active ?? true,
    pinned: false,
    windowId: 1,
    controllable: overrides.controllable ?? true,
    ...overrides,
  };
}

const SESSION32 = "a".repeat(32);

function makeSnapshot(tabId: string): Record<string, unknown> {
  return {
    snapshotId: `s-${SESSION32}-1`,
    tabId,
    url: "https://example.com/",
    title: "Example Domain",
    nodes: [
      { role: "heading", name: "Example Domain", level: 1 },
      { role: "text", name: "This domain is for use." },
      { ref: `e-${SESSION32}-1-1`, role: "link", name: "Learn more" },
    ],
    text: `[heading level=1] Example Domain\n[text] This domain is for use.\n[link ref=e-${SESSION32}-1-1] Learn more`,
    truncated: false,
    totalNodes: 3,
    includedNodes: 3,
  };
}

class FakeSnapshotRuntime extends BridgeRuntime {
  relayConnected = true;
  requests: Array<{ method: string; payload: Record<string, unknown> }> = [];
  failNext: BridgeError | null = null;
  tabs = new Map<string, BrowserTab>([[TAB_A, makeRecord(TAB_A)]]);
  snapshotPayload: Record<string, unknown> = makeSnapshot(TAB_A);

  constructor() {
    super({ pipeName: "\\\\.\\pipe\\arc-mcp-fake-snapshot", sessionDir: "C:\\arc-mcp-fake-snapshot" });
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
      const tabId = payload["tabId"];
      const found = typeof tabId === "string" ? this.tabs.get(tabId) : undefined;
      if (found === undefined) {
        throw new BridgeError("INVALID_ENVELOPE", "remote says gone", { remoteCode: "TAB_NOT_FOUND" });
      }
      return { tab: found };
    }
    if (method === "snapshot.capture") {
      return this.snapshotPayload;
    }
    if (method === "bridge.status" || method === "bridge.ping" || method === "bridge.hello") {
      return { connected: true };
    }
    throw new BridgeError("INVALID_ENVELOPE", `unexpected method ${method}`);
  }
}

function harness(): { engine: ExtensionEngine; runtime: FakeSnapshotRuntime } {
  const runtime = new FakeSnapshotRuntime();
  const engine = new ExtensionEngine({
      spec: arcSpec(),
    runtime,
    extensionId: EXTENSION_ID,
    connectTimeoutMs: 2_000,
    checkPrerequisites: () => Promise.resolve([]),
  });
  return { engine, runtime };
}

async function catchCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BrowserError);
    return (error as BrowserError).code;
  }
  throw new Error("expected action to throw");
}

describe("engine snapshot selection and gating", () => {
  it("requires a selected tab and sends no snapshot traffic without one", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    expect(await catchCode(() => engine.snapshot())).toBe("BROWSER_NO_SELECTED_TAB");
    expect(runtime.requests.filter((request) => request.method === "snapshot.capture")).toHaveLength(0);
  });

  it("clears disappeared selections with no fallback", async () => {
    const { engine } = harness();
    await engine.connect();
    await engine.selectTab(TAB_A);
    const runtime = (engine as unknown as { options: { runtime: FakeSnapshotRuntime } }).options.runtime;
    runtime.tabs.delete(TAB_A);
    expect(await catchCode(() => engine.snapshot())).toBe("BROWSER_TAB_NOT_FOUND");
    expect((await engine.status()).selectedTabId).toBeNull();
  });

  it("rejects privileged tabs before any snapshot.capture traffic", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    runtime.tabs.set(TAB_A, makeRecord(TAB_A, { url: "chrome://newtab/", controllable: false }));
    await engine.selectTab(TAB_A);
    const before = runtime.requests.filter((request) => request.method === "snapshot.capture").length;
    expect(await catchCode(() => engine.snapshot())).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
    expect(runtime.requests.filter((request) => request.method === "snapshot.capture").length).toBe(before);
  });

  it("rejects about:blank sources deterministically", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    runtime.tabs.set(TAB_A, makeRecord(TAB_A, { url: "about:blank", controllable: false }));
    await engine.selectTab(TAB_A);
    expect(await catchCode(() => engine.snapshot())).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
  });
});

describe("engine snapshot mapping", () => {
  it("returns the semantic snapshot through the typed RPC only", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    await engine.selectTab(TAB_A);
    const result = await engine.snapshot();
    expect(result.snapshotId).toBe(`s-${SESSION32}-1`);
    expect(result.tabId).toBe(TAB_A);
    expect(result.url).toBe("https://example.com/");
    expect(result.title).toBe("Example Domain");
    expect(result.nodes.some((node) => node.role === "link" && node.ref === `e-${SESSION32}-1-1`)).toBe(true);
    expect(findLeakedCdpKeys(result)).toEqual([]);
    const capture = runtime.requests.filter((request) => request.method === "snapshot.capture");
    expect(capture).toHaveLength(1);
    expect(capture[0]?.payload["tabId"]).toBe(TAB_A);
    // No tabId-free fallback, no CDP method names cross the bridge.
    expect(JSON.stringify(capture)).not.toContain("Accessibility");
  });

  it("maps debugger conflicts without stealing", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    await engine.selectTab(TAB_A);
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "another debugger attached", {
      remoteCode: "DEBUGGER_UNAVAILABLE",
    });
    expect(await catchCode(() => engine.snapshot())).toBe("BROWSER_DEBUGGER_UNAVAILABLE");
  });

  it("maps tab loss and clears selection; maps generic failures to snapshot failed", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    await engine.selectTab(TAB_A);
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "gone", { remoteCode: "TAB_NOT_FOUND" });
    expect(await catchCode(() => engine.snapshot())).toBe("BROWSER_TAB_NOT_FOUND");
    expect((await engine.status()).selectedTabId).toBeNull();

    const second = harness();
    await second.engine.connect();
    await second.engine.selectTab(TAB_A);
    second.runtime.failNext = new BridgeError("TIMEOUT", "bridge silent");
    expect(await catchCode(() => second.engine.snapshot())).toBe("BROWSER_SNAPSHOT_FAILED");
  });

  it("rejects leaked internal ids and wrong-tab payloads", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    await engine.selectTab(TAB_A);
    runtime.snapshotPayload = {
      ...makeSnapshot(TAB_A),
      nodes: [{ role: "link", name: "x", ref: `e-${SESSION32}-1-1` } as unknown],
    };
    const ok = await engine.snapshot();
    expect(ok.nodes[0]?.ref).toBe(`e-${SESSION32}-1-1`);
    runtime.snapshotPayload = {
      ...makeSnapshot(TAB_A),
      nodes: [{ role: "link", name: "x", ref: `e-${SESSION32}-1-1` } as unknown],
      backendNodeId: 5,
    };
    expect(await catchCode(() => engine.snapshot())).toBe("BROWSER_SNAPSHOT_FAILED");
    runtime.snapshotPayload = makeSnapshot(`t-${"b".repeat(32)}-99`);
    expect(await catchCode(() => engine.snapshot())).toBe("BROWSER_SNAPSHOT_FAILED");
  });
});

describe("BrowserService snapshot delegation", () => {
  it("delegates snapshot and reports not-implemented without an engine", async () => {
    const { engine } = harness();
    await engine.connect();
    const service = new BrowserService(engine);
    await service.selectTab(TAB_A);
    const result = await service.snapshot();
    expect(result.tabId).toBe(TAB_A);
    const bare = new BrowserService();
    await expect(bare.snapshot()).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
  });
});
