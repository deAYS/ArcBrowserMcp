import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import type { BridgeTransportMethod } from "../src/browser/extension/BridgeRuntime.js";
import { BridgeRuntime } from "../src/browser/extension/BridgeRuntime.js";

import { arcSpec } from "../src/browser/chromium/spec.js";
import { ExtensionEngine } from "../src/browser/extension/ExtensionEngine.js";
import { BrowserService } from "../src/browser/BrowserService.js";
import { BrowserError } from "../src/errors/BrowserError.js";
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
      method === "interaction.pressKey" ||
      method === "interaction.typeHuman" ||
      method === "interaction.pressSequence" ||
      method === "interaction.clickType"
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

function harness(): { engine: ExtensionEngine; runtime: FakeInteractionRuntime } {
  const runtime = new FakeInteractionRuntime();
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
    expect(await catchCode(() => engine.pressKey("Super+Enter"))).toBe("BROWSER_INVALID_KEY");
    expect(await catchCode(() => engine.pressSequence([]))).toBe("BROWSER_INVALID_KEY");
    expect(await catchCode(() => engine.pressSequence(["Enter"], { delayMs: 5000 }))).toBe("BROWSER_INVALID_KEY");
    expect(await catchCode(() => engine.typeHuman(REF, "hi", { wpm: 5 }))).toBe("BROWSER_INVALID_TEXT");
    expect(runtime.requests.length).toBe(before);
    await engine.pressKey("Control+Enter");
    expect(runtime.requests.some((request) => request.method === "interaction.pressKey")).toBe(true);
    await engine.pressKey("F1");
    await engine.pressKey("Control+a");
  });

  it("sends humanized RPC with pacing params and maps remote codes", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    await engine.selectTab(TAB_A);
    runtime.requests.length = 0;
    await engine.typeHuman(REF, "hello", { wpm: 90 });
    await engine.pressSequence(["Control+a", "Backspace"], { delayMs: 25 });
    await engine.clickType(REF, "search", { humanize: true, wpm: 100, submitKey: "Enter" });
    const methods = runtime.requests.map((request) => request.method);
    expect(methods).toEqual(["interaction.typeHuman", "interaction.pressSequence", "interaction.clickType"]);
    expect(runtime.requests[0]?.payload).toMatchObject({ tabId: TAB_A, ref: REF, wpm: 90, mode: "keys" });
    expect(runtime.requests[1]?.payload).toMatchObject({ tabId: TAB_A, delayMs: 25 });
    expect(runtime.requests[2]?.payload).toMatchObject({ tabId: TAB_A, ref: REF, submitKey: "Enter", mode: "keys" });
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "stale", { remoteCode: "STALE_ELEMENT" });
    expect(await catchCode(() => engine.typeHuman(REF, "hi"))).toBe("BROWSER_STALE_ELEMENT");
  });

  it("validates humanize flags, typing modes, and the keys-mode budget", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    await engine.selectTab(TAB_A);
    runtime.requests.length = 0;
    await engine.click(REF);
    expect(runtime.requests[0]?.payload).toMatchObject({ tabId: TAB_A, ref: REF });
    expect(runtime.requests[0]?.payload).not.toHaveProperty("humanize");
    await engine.click(REF, { humanize: true });
    expect(runtime.requests[1]?.payload).toMatchObject({ tabId: TAB_A, ref: REF, humanize: true });
    await engine.typeHuman(REF, "hello", { mode: "insert" });
    expect(runtime.requests[2]?.payload).toMatchObject({ mode: "insert" });
    await engine.clickType(REF, "search", { mode: "insert" });
    expect(runtime.requests[3]?.payload).toMatchObject({ mode: "insert" });
    const before = runtime.requests.length;
    expect(await catchCode(() => engine.click(REF, { humanize: "yes" as unknown as boolean }))).toBe(
      "BROWSER_INTERACTION_FAILED",
    );
    expect(await catchCode(() => engine.typeHuman(REF, "hi", { mode: "fast" as unknown as "keys" }))).toBe(
      "BROWSER_INVALID_TEXT",
    );
    expect(await catchCode(() => engine.typeHuman(REF, "x".repeat(1501)))).toBe("BROWSER_INVALID_TEXT");
    expect(await catchCode(() => engine.clickType(REF, "x".repeat(1501)))).toBe("BROWSER_INVALID_TEXT");
    expect(await catchCode(() => engine.clickType(REF, "hi", { mode: "nope" as unknown as "keys" }))).toBe(
      "BROWSER_INVALID_TEXT",
    );
    expect(runtime.requests.length).toBe(before);
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
    await expect(service.typeHuman(REF, "hello")).resolves.toEqual({ accepted: true });
    await expect(service.pressSequence(["Enter", "Tab"])).resolves.toEqual({ accepted: true });
    await expect(service.clickType(REF, "hello")).resolves.toEqual({ accepted: true });
    await expect(service.getText(REF)).resolves.toEqual({ text: "Interaction Fixture" });
    expect(runtime.requests.map((request) => request.method)).toEqual([
      "interaction.click",
      "interaction.fill",
      "interaction.type",
      "interaction.pressKey",
      "interaction.typeHuman",
      "interaction.pressSequence",
      "interaction.clickType",
      "interaction.getText",
    ]);
    const bare = new BrowserService();
    await expect(bare.click(REF)).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(bare.fill(REF, "x")).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(bare.type(REF, "x")).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(bare.pressKey("Enter")).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(bare.typeHuman(REF, "x")).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(bare.pressSequence(["Enter"])).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(bare.clickType(REF, "x")).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
    await expect(bare.getText(REF)).rejects.toMatchObject({ code: "BROWSER_OPERATION_NOT_IMPLEMENTED" });
  });
});
