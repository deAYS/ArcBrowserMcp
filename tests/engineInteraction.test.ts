import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import type { BridgeTransportMethod } from "../src/browser/extension/BridgeRuntime.js";
import { BridgeRuntime } from "../src/browser/extension/BridgeRuntime.js";
import { ArcExtensionEngine } from "../src/browser/extension/ArcExtensionEngine.js";
import { BrowserService } from "../src/browser/BrowserService.js";
import { ArcError } from "../src/errors/ArcError.js";
import { INTERACTION_TEXT_LIMIT_BYTES } from "../src/browser/interactionPolicy.js";
import type { BrowserTab } from "../src/browser/models.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const TAB_A = `t-${"a".repeat(32)}-11`;
const TAB_B = `t-${"a".repeat(32)}-22`;
const REF = `e-${"a".repeat(32)}-0-1`;

function makeRecord(id: string, overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id,
    title: "Fixture",
    url: "https://fixture.local/",
    active: true,
    pinned: false,
    windowId: 1,
    controllable: true,
    ...overrides,
  };
}

class FakeInteractionRuntime extends BridgeRuntime {
  relayConnected = true;
  requests: Array<{ method: string; payload: Record<string, unknown> }> = [];
  failNext: BridgeError | null = null;
  tabs = new Map<string, BrowserTab>([
    [TAB_A, makeRecord(TAB_A)],
    [TAB_B, makeRecord(TAB_B, { url: "https://other.local/" })],
  ]);
  textPayload: Record<string, unknown> = { text: "Interaction Fixture", role: "heading", source: "accessibility" };

  constructor() {
    super({ pipeName: "\\\\.\\pipe\\arc-mcp-fake-interaction", sessionDir: "C:\\arc-mcp-fake-interaction" });
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

  override async request(method: BridgeTransportMethod, payload: Record<string, unknown> = {}): Promise<unknown> {
    // tabs.list is selection-reconcile traffic: serve it but keep it out
    // of interaction-traffic assertions (same convention as tabs/snapshot
    // engine fakes) so failNext targets exactly the interaction RPC.
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
      return { tab: found };
    }
    if (
      method === "interaction.click" ||
      method === "interaction.fill" ||
      method === "interaction.type" ||
      method === "interaction.pressKey"
    ) {
      return { accepted: true };
    }
    if (method === "interaction.getText") {
      return this.textPayload;
    }
    if (method === "bridge.status") {
      return { connected: true };
    }
    throw new BridgeError("INVALID_ENVELOPE", `unexpected method ${method}`);
  }
}

function harness(): { engine: ArcExtensionEngine; runtime: FakeInteractionRuntime } {
  const runtime = new FakeInteractionRuntime();
  const engine = new ArcExtensionEngine({
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
    expect(error).toBeInstanceOf(ArcError);
    return (error as ArcError).code;
  }
  throw new Error("expected action to throw");
}

describe("engine interaction selection gating", () => {
  it("requires selection and reconciles vanished/privileged tabs before RPC", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    runtime.requests.length = 0;
    expect(await catchCode(() => engine.click(REF))).toBe("BROWSER_NO_SELECTED_TAB");
    expect(runtime.requests).toHaveLength(0);

    await engine.selectTab(TAB_A);
    runtime.tabs.delete(TAB_A);
    expect(await catchCode(() => engine.click(REF))).toBe("BROWSER_TAB_NOT_FOUND");
    expect((await engine.status()).selectedTabId).toBeNull();

    const second = harness();
    await second.engine.connect();
    second.runtime.requests.length = 0;
    second.runtime.tabs.set(TAB_A, makeRecord(TAB_A, { url: "chrome://newtab/", controllable: false }));
    await second.engine.selectTab(TAB_A);
    second.runtime.requests.length = 0;
    const before = second.runtime.requests.length;
    expect(await catchCode(() => second.engine.click(REF))).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
    expect(second.runtime.requests.length).toBe(before);
  });

  it("sends typed RPC with tabId+ref and maps remote codes", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    await engine.selectTab(TAB_A);
    await engine.click(REF);
    const click = runtime.requests.find((request) => request.method === "interaction.click");
    expect(click?.payload).toMatchObject({ tabId: TAB_A, ref: REF });

    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "stale", { remoteCode: "STALE_ELEMENT" });
    expect(await catchCode(() => engine.click(REF))).toBe("BROWSER_STALE_ELEMENT");
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "busy", { remoteCode: "DEBUGGER_UNAVAILABLE" });
    expect(await catchCode(() => engine.click(REF))).toBe("BROWSER_DEBUGGER_UNAVAILABLE");
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "gone", { remoteCode: "TAB_NOT_FOUND" });
    expect(await catchCode(() => engine.click(REF))).toBe("BROWSER_TAB_NOT_FOUND");
    expect((await engine.status()).selectedTabId).toBeNull();
  });

  it("validates text size and key allowlist before bridge traffic", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    await engine.selectTab(TAB_A);
    const before = runtime.requests.length;
    expect(await catchCode(() => engine.fill(REF, "x".repeat(INTERACTION_TEXT_LIMIT_BYTES + 1)))).toBe(
      "BROWSER_INVALID_TEXT",
    );
    expect(await catchCode(() => engine.type(REF, "x".repeat(INTERACTION_TEXT_LIMIT_BYTES + 1)))).toBe(
      "BROWSER_INVALID_TEXT",
    );
    expect(await catchCode(() => engine.pressKey("F1"))).toBe("BROWSER_INVALID_KEY");
    expect(runtime.requests.length).toBe(before);
    await engine.pressKey("Control+Enter");
    expect(runtime.requests.some((request) => request.method === "interaction.pressKey")).toBe(true);
  });

  it("returns getText text and validates the envelope; errors never echo secrets", async () => {
    const sentinel = `test-secret-sentinel-${"ab".repeat(8)}`;
    const { engine, runtime } = harness();
    await engine.connect();
    await engine.selectTab(TAB_A);
    expect(await engine.getText(REF)).toBe("Interaction Fixture");
    runtime.textPayload = { text: 5 };
    expect(await catchCode(() => engine.getText(REF))).toBe("BROWSER_SNAPSHOT_FAILED");
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "denied", { remoteCode: "ELEMENT_NOT_EDITABLE" });
    const code = await catchCode(() => engine.fill(REF, sentinel));
    expect(code).toBe("BROWSER_ELEMENT_NOT_EDITABLE");
  });
});

describe("BrowserService interaction delegation", () => {
  it("delegates click/fill/type/pressKey/getText and reports not-implemented without an engine", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    const service = new BrowserService(engine);
    await service.selectTab(TAB_A);
    runtime.requests.length = 0;
    await expect(service.click(REF)).resolves.toEqual({ accepted: true });
    await expect(service.fill(REF, "hello")).resolves.toEqual({ accepted: true });
    await expect(service.type(REF, "x")).resolves.toEqual({ accepted: true });
    await expect(service.pressKey("Enter")).resolves.toEqual({ accepted: true });
    await expect(service.getText(REF)).resolves.toEqual({ text: "Interaction Fixture" });
    expect(runtime.requests.map((request) => request.method)).toEqual([
      "interaction.click",
      "interaction.fill",
      "interaction.type",
      "interaction.pressKey",
      "interaction.getText",
    ]);
    const bare = new BrowserService();
    await expect(bare.click(REF)).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(bare.fill(REF, "x")).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(bare.type(REF, "x")).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(bare.pressKey("Enter")).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(bare.getText(REF)).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
  });
});
