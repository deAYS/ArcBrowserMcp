import { describe, expect, it } from "vitest";
import { BrowserError } from "../src/errors/BrowserError.js";
import type { ChromiumLaunchConfig } from "../src/browser/chromium/launchConfig.js";
import { BrowserLauncher } from "../src/browser/chromium/launcher.js";
import { BrowserService } from "../src/browser/BrowserService.js";
import { CdpBrowserEngine } from "../src/browser/cdp/CdpBrowserEngine.js";
import { CdpConnection } from "../src/browser/cdp/CdpConnection.js";
import { arcSpec } from "../src/browser/chromium/spec.js";
import type { CdpVersionInfo } from "../src/browser/cdp/CdpReadiness.js";

const FAKE_CONFIG: ChromiumLaunchConfig = {
  executablePath: "C:\\Arc\\Arc.exe",
  profilePath: "C:\\arc-mcp-test\\profile",
  debugPort: 9333,
  args: [],
};

const FAKE_VERSION: CdpVersionInfo = {
  browser: "Arc/test",
  protocolVersion: "1.3",
  webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/x",
};

class FakeLauncher extends BrowserLauncher {
  launched = false;
  shutdownCalls = 0;
  running = true;

  constructor() {
    super(FAKE_CONFIG);
  }

  override async launch(): Promise<void> {
    this.launched = true;
  }

  override isRunning(): boolean {
    return this.running;
  }

  override describeExit(): string {
    return "fake-exit";
  }

  override async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.running = false;
  }
}

class FakeConnection extends CdpConnection {
  private live = false;
  private contexts = 2;
  private readonly listeners: Array<() => void> = [];
  gracefulCalls = 0;
  released = false;

  override async connect(_port: number): Promise<void> {
    this.live = true;
  }

  override isConnected(): boolean {
    return this.live;
  }

  override contextCount(): number {
    return this.live ? this.contexts : 0;
  }

  override onDisconnected(listener: () => void): void {
    this.listeners.push(listener);
  }

  fireDisconnected(): void {
    this.live = false;
    const pending = this.listeners.splice(0, this.listeners.length);
    for (const listener of pending) {
      listener();
    }
  }

  /** Simulate transport death without notifying (stale handle). */
  killSilently(): void {
    this.live = false;
  }

  override async gracefulBrowserClose(): Promise<boolean> {
    this.gracefulCalls += 1;
    return true;
  }

  override async release(): Promise<void> {
    this.released = true;
    this.live = false;
  }
}

interface Harness {
  readonly engine: CdpBrowserEngine;
  readonly launcher: FakeLauncher;
  readonly connection: FakeConnection;
}

function harness(): Harness {
  const launcher = new FakeLauncher();
  const connection = new FakeConnection();
  const engine = new CdpBrowserEngine(
    { spec: arcSpec(), executablePath: undefined, profilePath: undefined, debugPort: 9333 },
    {
      discover: () =>
        Promise.resolve({
          executablePath: FAKE_CONFIG.executablePath,
          source: "explicit" as const,
        }),
      createLauncher: () => launcher,
      createConnection: () => connection,
      waitReady: () => Promise.resolve(FAKE_VERSION),
    },
  );
  return { engine, launcher, connection };
}

describe("CdpBrowserEngine lifecycle", () => {
  it("connects through launcher, readiness, and connection, then reports connected", async () => {
    const { engine, launcher } = harness();
    expect((await engine.status()).state).toBe("disconnected");
    await engine.connect();
    expect(launcher.launched).toBe(true);
    const status = await new BrowserService(engine).getStatus();
    expect(status.connected).toBe(true);
    expect(status.state).toBe("connected");
    expect(status.backend).toBe("cdp");
    expect(status.cdpPort).toBe(9333);
    expect(status.discoverySource).toBe("explicit");
    expect(status.contextCount).toBe(2);
    expect(status.selectedTabId).toBeNull();
  });

  it("failed readiness leaves error state and cleans up the owned process", async () => {
    const launcher = new FakeLauncher();
    const connection = new FakeConnection();
    const failing = new CdpBrowserEngine(
      { spec: arcSpec(), executablePath: undefined, profilePath: undefined, debugPort: 9333 },
      {
        discover: () =>
          Promise.resolve({ executablePath: FAKE_CONFIG.executablePath, source: "explicit" as const }),
        createLauncher: () => launcher,
        createConnection: () => connection,
        waitReady: () => Promise.reject(new BrowserError("BROWSER_CDP_READY_TIMEOUT", "timeout", {})),
      },
    );
    let caught: unknown = null;
    try {
      await failing.connect();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrowserError);
    expect((caught as BrowserError).code).toBe("BROWSER_CDP_READY_TIMEOUT");
    const status = await failing.status();
    expect(status.state).toBe("error");
    expect(status.connected).toBe(false);
    expect(status.lastErrorCode).toBe("BROWSER_CDP_READY_TIMEOUT");
    expect(launcher.shutdownCalls).toBe(1);
    expect(connection.released).toBe(true);
  });

  it("remote browser loss clears connected state without relaunch", async () => {
    const { engine, connection } = harness();
    await engine.connect();
    expect((await engine.status()).connected).toBe(true);
    connection.fireDisconnected();
    const status = await engine.status();
    expect(status.connected).toBe(false);
    expect(status.state).toBe("disconnected");
  });

  it("a dead transport under a connected engine is reported as disconnected", async () => {
    const { engine, connection } = harness();
    await engine.connect();
    connection.killSilently();
    const status = await engine.status();
    expect(status.connected).toBe(false);
    expect(status.state).toBe("disconnected");
  });

  it("disconnect prefers graceful close, then releases, and reports disconnected", async () => {
    const { engine, launcher, connection } = harness();
    await engine.connect();
    await engine.disconnect();
    expect(connection.gracefulCalls).toBe(1);
    expect(connection.released).toBe(true);
    expect(launcher.shutdownCalls).toBe(1);
    const status = await engine.status();
    expect(status.connected).toBe(false);
    expect(status.state).toBe("disconnected");
  });

  it("reports connecting while startup is in flight", async () => {
    let observed: string | null = null;
    const slow: CdpBrowserEngine = new CdpBrowserEngine(
      { spec: arcSpec(), executablePath: undefined, profilePath: undefined, debugPort: 9333 },
      {
        discover: () =>
          Promise.resolve({ executablePath: FAKE_CONFIG.executablePath, source: "explicit" as const }),
        createLauncher: () => new FakeLauncher(),
        createConnection: () => new FakeConnection(),
        waitReady: () => slow.status().then((s) => {
          observed = s.state;
          return FAKE_VERSION;
        }),
      },
    );
    await slow.connect();
    expect(observed).toBe("connecting");
    expect((await slow.status()).state).toBe("connected");
  });
});

describe("CdpBrowserEngine future operations", () => {
  it("rejects with typed not-implemented errors naming the operation", async () => {
    const { engine } = harness();
    for (const operation of ["listTabs", "navigate", "snapshot", "screenshot", "evaluate"] as const) {
      let caught: unknown = null;
      try {
        if (operation === "listTabs") {
          await engine.listTabs();
        } else if (operation === "navigate") {
          await engine.navigate({ url: "https://example.com" });
        } else if (operation === "snapshot") {
          await engine.snapshot();
        } else if (operation === "screenshot") {
          await engine.screenshot();
        } else {
          await engine.evaluate("1+1");
        }
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BrowserError);
      expect((caught as BrowserError).code).toBe("BROWSER_OPERATION_NOT_IMPLEMENTED");
      expect((caught as BrowserError).details["operation"]).toBe(operation);
    }
  });
});

describe("BrowserService without an engine", () => {
  it("keeps the disconnected placeholder contract", async () => {
    const status = await new BrowserService().getStatus();
    expect(status).toMatchObject({
      connected: false,
      state: "disconnected",
      backend: "none",
      profileMode: "dedicated-mcp-profile",
      selectedTabId: null,
      reason: "browser-engine-not-implemented",
    });
  });
});
