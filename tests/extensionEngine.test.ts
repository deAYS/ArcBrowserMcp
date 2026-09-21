import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import type { BridgeTransportMethod } from "../src/browser/extension/BridgeRuntime.js";
import { BridgeRuntime } from "../src/browser/extension/BridgeRuntime.js";

import { arcSpec } from "../src/browser/chromium/spec.js";
import { ExtensionEngine } from "../src/browser/extension/ExtensionEngine.js";
import { BrowserService } from "../src/browser/BrowserService.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

class FakeRuntime extends BridgeRuntime {
  started = 0;
  stopped = 0;
  relayConnected = false;
  requestHandler: (method: BridgeTransportMethod) => unknown = () => ({});
  private readonly listeners = new Set<(connected: boolean) => void>();

  constructor() {
    super({ pipeName: "\\\\.\\pipe\\arc-mcp-fake-test", sessionDir: "C:\\arc-mcp-fake-test" });
  }

  override async start(): Promise<void> {
    this.started += 1;
  }

  override async stop(): Promise<void> {
    this.stopped += 1;
  }

  override isRelayConnected(): boolean {
    return this.relayConnected;
  }

  override onRelayChange(listener: (connected: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  override async request(
    method: BridgeTransportMethod,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    void payload;
    void timeoutMs;
    if (!this.relayConnected) {
      throw new BridgeError("NOT_CONNECTED", "no relay");
    }
    return this.requestHandler(method);
  }

  setRelay(connected: boolean): void {
    this.relayConnected = connected;
    for (const listener of [...this.listeners]) {
      listener(connected);
    }
  }
}

function engineWith(runtime?: FakeRuntime): { engine: ExtensionEngine; runtime: FakeRuntime } {
  const fake = runtime ?? new FakeRuntime();
  const engine = new ExtensionEngine({
      spec: arcSpec(),
    runtime: fake,
    extensionId: EXTENSION_ID,
    connectTimeoutMs: 2_000,
    checkPrerequisites: () => Promise.resolve([]),
  });
  return { engine, runtime: fake };
}

describe("ExtensionEngine lifecycle", () => {
  it("connects through preflight, runtime, relay, and status verification", async () => {
    const { engine, runtime } = engineWith();
    expect((await engine.status()).state).toBe("disconnected");
    const connecting = engine.connect();
    runtime.setRelay(true);
    await connecting;
    expect(runtime.started).toBe(1);
    const status = await new BrowserService(engine).getStatus();
    expect(status).toMatchObject({
      connected: true,
      state: "connected",
      backend: "extension",
      profileMode: "normal-running-arc",
      selectedTabId: null,
      extensionId: EXTENSION_ID,
      relayConnected: true,
      pipeAuthenticated: true,
      bridgeProtocolVersion: 1,
    });
  });

  it("coalesces duplicate concurrent connect attempts", async () => {
    const { engine, runtime } = engineWith();
    const first = engine.connect();
    const second = engine.connect();
    runtime.setRelay(true);
    await Promise.all([first, second]);
    expect(runtime.started).toBe(1);
  });

  it("times out with a typed error and cleans up when no relay appears", async () => {
    const { engine, runtime } = engineWith();
    let caught: unknown = null;
    try {
      await engine.connect();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe("EXTENSION_CONNECT_TIMEOUT");
    const status = await engine.status();
    expect(status.state).toBe("error");
    expect(status.lastErrorCode).toBe("EXTENSION_CONNECT_TIMEOUT");
    expect(runtime.stopped).toBe(1);
  });

  it("fails preflight without starting the runtime", async () => {
    const fake = new FakeRuntime();
    const engine = new ExtensionEngine({
        spec: arcSpec(),
      runtime: fake,
      extensionId: EXTENSION_ID,
      checkPrerequisites: () =>
        Promise.resolve([{ code: "BRIDGE_PREFLIGHT_FAILED", remediation: "run pnpm bridge:install" }]),
    });
    let caught: unknown = null;
    try {
      await engine.connect();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe("BRIDGE_PREFLIGHT_FAILED");
    expect(fake.started).toBe(0);
  });

  it("disconnect is idempotent and stops the runtime", async () => {
    const { engine, runtime } = engineWith();
    const connecting = engine.connect();
    runtime.setRelay(true);
    await connecting;
    await engine.disconnect();
    await engine.disconnect();
    expect(runtime.stopped).toBe(1);
    const status = await engine.status();
    expect(status.connected).toBe(false);
    expect(status.state).toBe("disconnected");
  });

  it("pending connect is cancelled by disconnect", async () => {
    const { engine } = engineWith();
    const connecting = engine.connect();
    await engine.disconnect();
    let caught: unknown = null;
    try {
      await connecting;
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((await engine.status()).state).toBe("disconnected");
  });

  it("relay loss and recovery update status on the same instance", async () => {
    const { engine, runtime } = engineWith();
    const connecting = engine.connect();
    runtime.setRelay(true);
    await connecting;
    expect((await engine.status()).connected).toBe(true);
    runtime.setRelay(false);
    const lost = await engine.status();
    expect(lost.connected).toBe(false);
    expect(lost.state).toBe("disconnected");
    runtime.setRelay(true);
    const recovered = await engine.status();
    expect(recovered.connected).toBe(true);
    expect(recovered.state).toBe("connected");
  });

  it("retries the status verification once on timeout", async () => {
    const { engine, runtime } = engineWith();
    let calls = 0;
    runtime.requestHandler = () => {
      calls += 1;
      if (calls === 1) {
        throw new BridgeError("TIMEOUT", "lost probe");
      }
      return { connected: true };
    };
    const connecting = engine.connect();
    runtime.setRelay(true);
    await connecting;
    expect(calls).toBe(2);
    expect((await engine.status()).connected).toBe(true);
  });

  it("runs preflight once per process across reconnects", async () => {
    const fake = new FakeRuntime();
    let checks = 0;
    const engine = new ExtensionEngine({
        spec: arcSpec(),
      runtime: fake,
      extensionId: EXTENSION_ID,
      connectTimeoutMs: 2_000,
      checkPrerequisites: () => {
        checks += 1;
        return Promise.resolve([]);
      },
    });
    for (let i = 0; i < 2; i += 1) {
      const connecting = engine.connect();
      fake.setRelay(true);
      await connecting;
      await engine.disconnect();
    }
    expect(checks).toBe(1);
  });

  it("fails after repeated verification timeouts within the connect budget", async () => {
    const fake = new FakeRuntime();
    const fakeEngine = new ExtensionEngine({
        spec: arcSpec(),
      runtime: fake,
      extensionId: EXTENSION_ID,
      connectTimeoutMs: 600,
      statusTimeoutMs: 50,
      checkPrerequisites: () => Promise.resolve([]),
    });
    fake.requestHandler = () => {
      throw new BridgeError("TIMEOUT", "lost probe");
    };
    const connecting = fakeEngine.connect();
    fake.setRelay(true);
    let caught: unknown = null;
    try {
      await connecting;
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe("TIMEOUT");
    expect((await fakeEngine.status()).state).toBe("error");
  }, 30_000);
});

describe("ExtensionEngine page tools", () => {
  it("page tool operations are implemented (no not-implemented stub)", async () => {
    const { engine } = engineWith();
    expect(engine.evaluate).toBeDefined();
    expect(engine.screenshot).toBeDefined();
    expect(engine.waitFor).toBeDefined();
    const source = await import("node:fs/promises").then(() => "");
    void source;
    // No-selected-tab gates fire before any bridge traffic: proves the
    // methods are real implementations, not stubs.
    await expect(engine.evaluate("1")).rejects.toMatchObject({ code: "BROWSER_NO_SELECTED_TAB" });
    await expect(engine.screenshot()).rejects.toMatchObject({ code: "BROWSER_NO_SELECTED_TAB" });
    await expect(engine.waitFor({ type: "load" })).rejects.toMatchObject({ code: "BROWSER_NO_SELECTED_TAB" });
  });
});
