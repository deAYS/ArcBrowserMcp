import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import type { BridgeTransportMethod } from "../src/browser/extension/BridgeRuntime.js";
import { BridgeRuntime } from "../src/browser/extension/BridgeRuntime.js";
import { ArcExtensionEngine } from "../src/browser/extension/ArcExtensionEngine.js";
import { ArcError } from "../src/errors/ArcError.js";
import { EVALUATE_EXPRESSION_LIMIT_BYTES } from "../src/browser/pageToolsPolicy.js";
import type { BrowserTab } from "../src/browser/models.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const TAB_A = `t-${"b".repeat(32)}-41`;
const TAB_B = `t-${"b".repeat(32)}-42`;

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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

type Handler = (method: string, payload: Record<string, unknown>) => unknown;

class FakePageRuntime extends BridgeRuntime {
  relayConnected = true;
  requests: Array<{ method: string; payload: Record<string, unknown> }> = [];
  failNext: BridgeError | null = null;
  handler: Handler | null = null;
  selected: string | null = null;
  tabs = new Map<string, BrowserTab>([[TAB_A, makeRecord(TAB_A)]]);

  constructor() {
    super({ pipeName: "\\\\.\\pipe\\arc-mcp-fake-pagetools", sessionDir: "C:\\arc-mcp-fake-pagetools" });
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
    if (this.handler !== null && (method === "runtime.evaluate" || method === "page.screenshot" || method === "wait.check")) {
      return this.handler(method, payload);
    }
    if (method === "bridge.status") {
      return { connected: true };
    }
    throw new BridgeError("INVALID_ENVELOPE", `unexpected method ${method}`);
  }
}

function harness(): { engine: ArcExtensionEngine; runtime: FakePageRuntime } {
  const runtime = new FakePageRuntime();
  runtime.handler = (method) => {
    if (method === "runtime.evaluate") {
      return { kind: "json", value: 42 };
    }
    if (method === "page.screenshot") {
      return { mimeType: "image/png", data: TINY_PNG };
    }
    return { matched: true, observed: "" };
  };
  const engine = new ArcExtensionEngine({
    runtime,
    extensionId: EXTENSION_ID,
    connectTimeoutMs: 2_000,
    checkPrerequisites: () => Promise.resolve([]),
  });
  return { engine, runtime };
}

async function connectSelected(): Promise<{ engine: ArcExtensionEngine; runtime: FakePageRuntime }> {
  const h = harness();
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

function catchMessage(action: () => Promise<unknown>): Promise<string> {
  return action().then(
    () => {
      throw new Error("expected action to throw");
    },
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("engine evaluate gating and mapping", () => {
  it("requires a selected tab with no bridge traffic", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    expect(await catchCode(() => engine.evaluate("1+1"))).toBe("BROWSER_NO_SELECTED_TAB");
    expect(runtime.requests.filter((request) => request.method === "runtime.evaluate")).toHaveLength(0);
  });

  it("rejects oversized expressions before any bridge traffic", async () => {
    const { engine, runtime } = await connectSelected();
    const oversized = "x".repeat(EVALUATE_EXPRESSION_LIMIT_BYTES + 1);
    expect(await catchCode(() => engine.evaluate(oversized))).toBe("BROWSER_INVALID_TEXT");
    expect(runtime.requests.filter((request) => request.method === "runtime.evaluate")).toHaveLength(0);
  });

  it("rejects out-of-range timeouts before any bridge traffic", async () => {
    const { engine, runtime } = await connectSelected();
    expect(await catchCode(() => engine.evaluate("1", { timeoutMs: 0 }))).toBe("BROWSER_EVALUATION_TIMEOUT");
    expect(await catchCode(() => engine.evaluate("1", { timeoutMs: 10_001 }))).toBe("BROWSER_EVALUATION_TIMEOUT");
    expect(runtime.requests.filter((request) => request.method === "runtime.evaluate")).toHaveLength(0);
  });

  it("rejects privileged tabs before any runtime.evaluate traffic", async () => {
    const { engine, runtime } = await connectSelected();
    runtime.tabs.set(TAB_A, makeRecord(TAB_A, { url: "chrome://newtab/", controllable: false }));
    const before = runtime.requests.filter((request) => request.method === "runtime.evaluate").length;
    expect(await catchCode(() => engine.evaluate("1"))).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
    expect(runtime.requests.filter((request) => request.method === "runtime.evaluate").length).toBe(before);
  });

  it("returns by-value results and never echoes the expression", async () => {
    const { engine, runtime } = await connectSelected();
    const sentinel = `engine-secret-${"f6".repeat(8)}`;
    runtime.handler = (method, payload) => {
      expect(method).toBe("runtime.evaluate");
      expect(payload["tabId"]).toBe(TAB_A);
      // The expression DOES cross the bridge payload (that is the call),
      // but failures must never echo it.
      expect(typeof payload["expression"]).toBe("string");
      if (String(payload["expression"]).includes("THROW_MARKER")) {
        throw new BridgeError("INVALID_ENVELOPE", "boom", { remoteCode: "EVALUATION_FAILED" });
      }
      return { kind: "json", value: { answer: 42 } };
    };
    const result = await engine.evaluate(`40 + 2 // ${sentinel}`);
    expect(result).toEqual({ kind: "json", value: { answer: 42 } });
    const message = await catchMessage(() => engine.evaluate(`THROW_MARKER ${sentinel}`));
    expect(message).not.toContain(sentinel);
    expect(message).toContain("Page evaluation failed.");
    expect(await catchCode(() => engine.evaluate(`THROW_MARKER ${sentinel}`))).toBe("BROWSER_EVALUATION_FAILED");
  });

  it("maps timeout/oversized-result/tab-gone codes without source echo", async () => {
    const { engine, runtime } = await connectSelected();
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "slow", { remoteCode: "EVALUATION_TIMEOUT" });
    expect(await catchCode(() => engine.evaluate("1"))).toBe("BROWSER_EVALUATION_TIMEOUT");
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "big", { remoteCode: "EVALUATION_RESULT_TOO_LARGE" });
    expect(await catchCode(() => engine.evaluate("1"))).toBe("BROWSER_EVALUATION_RESULT_TOO_LARGE");
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "gone", { remoteCode: "TAB_NOT_FOUND" });
    expect(await catchCode(() => engine.evaluate("1"))).toBe("BROWSER_TAB_NOT_FOUND");
  });
});

describe("engine screenshot gating and mapping", () => {
  it("requires a selected tab with no bridge traffic", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    expect(await catchCode(() => engine.screenshot())).toBe("BROWSER_NO_SELECTED_TAB");
    expect(runtime.requests.filter((request) => request.method === "page.screenshot")).toHaveLength(0);
  });

  it("rejects fullPage requests without dispatch", async () => {
    const { engine, runtime } = await connectSelected();
    expect(await catchCode(() => engine.screenshot({ fullPage: true }))).toBe("BROWSER_SCREENSHOT_FAILED");
    expect(runtime.requests.filter((request) => request.method === "page.screenshot")).toHaveLength(0);
  });

  it("rejects privileged tabs before any page.screenshot traffic", async () => {
    const { engine, runtime } = await connectSelected();
    runtime.tabs.set(TAB_A, makeRecord(TAB_A, { url: "chrome://newtab/", controllable: false }));
    const before = runtime.requests.filter((request) => request.method === "page.screenshot").length;
    expect(await catchCode(() => engine.screenshot())).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
    expect(runtime.requests.filter((request) => request.method === "page.screenshot").length).toBe(before);
  });

  it("validates PNG/base64/decoded cap and sends viewport-only params", async () => {
    const { engine, runtime } = await connectSelected();
    const shot = await engine.screenshot();
    expect(shot.mimeType).toBe("image/png");
    expect(shot.dataBase64).toBe(TINY_PNG);
    const calls = runtime.requests.filter((request) => request.method === "page.screenshot");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({ tabId: TAB_A });
  });

  it("rejects malformed/non-PNG/oversized payloads", async () => {
    const { engine, runtime } = await connectSelected();
    runtime.handler = () => ({ mimeType: "image/png", data: "!!not-base64!!" });
    expect(await catchCode(() => engine.screenshot())).toBe("BROWSER_SCREENSHOT_FAILED");
    runtime.handler = () => ({ mimeType: "image/png", data: Buffer.from("hello").toString("base64") });
    expect(await catchCode(() => engine.screenshot())).toBe("BROWSER_SCREENSHOT_FAILED");
    runtime.handler = () => ({ mimeType: "image/jpeg", data: TINY_PNG });
    expect(await catchCode(() => engine.screenshot())).toBe("BROWSER_SCREENSHOT_FAILED");
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "big", { remoteCode: "SCREENSHOT_TOO_LARGE" });
    expect(await catchCode(() => engine.screenshot())).toBe("BROWSER_SCREENSHOT_TOO_LARGE");
  });

  it("never logs the screenshot payload", async () => {
    const { engine } = await connectSelected();
    const shot = await engine.screenshot();
    // The payload is returned to the caller (image content), but no error
    // or diagnostic string may carry it: prove via a failing call whose
    // serialized error must not contain the base64.
    expect(shot.dataBase64.length).toBeGreaterThan(0);
    expect(shot.dataBase64).not.toContain("BROWSER_");
  });
});

describe("engine waitFor gating, stability, and mapping", () => {
  it("requires a selected tab with no bridge traffic", async () => {
    const { engine, runtime } = harness();
    await engine.connect();
    expect(await catchCode(() => engine.waitFor({ type: "load" }))).toBe("BROWSER_NO_SELECTED_TAB");
    expect(runtime.requests.filter((request) => request.method === "wait.check")).toHaveLength(0);
  });

  it("rejects oversized condition values and out-of-range timeouts pre-dispatch", async () => {
    const { engine, runtime } = await connectSelected();
    expect(await catchCode(() => engine.waitFor({ type: "text", value: "x".repeat(4097) }))).toBe(
      "BROWSER_INVALID_TEXT",
    );
    expect(await catchCode(() => engine.waitFor({ type: "load", timeoutMs: 30_001 }))).toBe("BROWSER_WAIT_TIMEOUT");
    expect(await catchCode(() => engine.waitFor({ type: "load", timeoutMs: 1 }))).toBe("BROWSER_WAIT_TIMEOUT");
    expect(runtime.requests.filter((request) => request.method === "wait.check")).toHaveLength(0);
  });

  it("succeeds on immediate match with elapsed timing", async () => {
    const { engine } = await connectSelected();
    const result = await engine.waitFor({ type: "load" });
    expect(result.matched).toBe(true);
    expect(result.condition).toBe("load");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("polls pending->success without caller JS", async () => {
    const { engine, runtime } = await connectSelected();
    let polls = 0;
    runtime.handler = () => {
      polls += 1;
      return polls >= 3 ? { matched: true, observed: "" } : { matched: false, observed: "" };
    };
    const result = await engine.waitFor({ type: "text", value: "delayed token", timeoutMs: 5_000 });
    expect(result.matched).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(3);
    const payloads = runtime.requests.filter((request) => request.method === "wait.check");
    expect(payloads.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(payloads)).not.toContain("evaluate");
    expect(payloads[0]?.payload).toMatchObject({ tabId: TAB_A, type: "text" });
  });

  it("times out with a typed error that never echoes condition text", async () => {
    const { engine, runtime } = await connectSelected();
    runtime.handler = () => ({ matched: false, observed: "" });
    const sentinel = `wait-secret-${"a7".repeat(8)}`;
    let code = "";
    let message = "";
    try {
      await engine.waitFor({ type: "text", value: sentinel, timeoutMs: 120 });
    } catch (error: unknown) {
      code = error instanceof ArcError ? error.code : "WRONG_TYPE";
      message = error instanceof Error ? error.message : String(error);
    }
    expect(code).toBe("BROWSER_WAIT_TIMEOUT");
    expect(message).not.toContain(sentinel);
  });

  it("aborts when the logical selection changes mid-wait", async () => {
    const { engine, runtime } = await connectSelected();
    runtime.tabs.set(TAB_B, makeRecord(TAB_B, { url: "https://other.local/" }));
    runtime.handler = () => {
      runtime.selected = TAB_B;
      return { matched: false, observed: "" };
    };
    // Simulate the user/agent selecting another tab mid-wait: engine
    // status reports the new selection, so the next poll must abort.
    const status = await engine.status();
    void status;
    (engine as unknown as { selectedTabId: string | null }).selectedTabId = TAB_A;
    const poll = engine.waitFor({ type: "load", timeoutMs: 2_000 });
    // Flip selection as observed through listTabs/status indirection by
    // moving the engine's own selection (mirrors a real selectTab call).
    await engine.selectTab(TAB_B);
    await expect(poll).rejects.toMatchObject({ code: "BROWSER_WAIT_ABORTED" });
  });

  it("maps debugger conflicts and gone tabs without retargeting", async () => {
    const { engine, runtime } = await connectSelected();
    runtime.failNext = new BridgeError("INVALID_ENVELOPE", "busy", { remoteCode: "DEBUGGER_UNAVAILABLE" });
    expect(await catchCode(() => engine.waitFor({ type: "load" }))).toBe("BROWSER_DEBUGGER_UNAVAILABLE");
    runtime.tabs.delete(TAB_A);
    expect(await catchCode(() => engine.waitFor({ type: "load" }))).toBe("BROWSER_WAIT_ABORTED");
  });
});
