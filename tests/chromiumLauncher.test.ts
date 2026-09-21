import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BrowserError } from "../src/errors/BrowserError.js";
import type { ChromiumLaunchConfig } from "../src/browser/chromium/launchConfig.js";
import { BrowserLauncher } from "../src/browser/chromium/launcher.js";
import type { SpawnFn } from "../src/browser/chromium/launcher.js";

const TEST_CONFIG: ChromiumLaunchConfig = {
  executablePath: "C:\\Arc\\Arc.exe",
  profilePath: "C:\\arc-mcp-test\\profile",
  debugPort: 9333,
  args: ["--user-data-dir=C:\\arc-mcp-test\\profile", "--remote-debugging-port=9333"],
};

class FakeChild extends EventEmitter {
  readonly pid: number | null = 4242;
  exitCode: number | null = null;
  killedWith: string[] = [];

  kill(signal?: string): boolean {
    this.killedWith.push(signal ?? "SIGTERM");
    return true;
  }
}

function fakeSpawn(child: FakeChild, behavior: "spawn" | "error"): SpawnFn {
  const fn = (): ChildProcess => {
    if (behavior === "spawn") {
      setImmediate(() => child.emit("spawn"));
    } else {
      setImmediate(() => child.emit("error", new Error("ENOENT")));
    }
    return child as unknown as ChildProcess;
  };
  return fn as SpawnFn;
}

async function captureCode(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected action to throw");
}

describe("BrowserLauncher", () => {
  it("refuses an occupied CDP port without spawning", async () => {
    let spawns = 0;
    const launcher = new BrowserLauncher(TEST_CONFIG, {
      ensureDir: () => Promise.resolve(),
      portOccupied: () => Promise.resolve(true),
      spawnImpl: (() => {
        spawns += 1;
        throw new Error("must not spawn");
      }) as SpawnFn,
    });
    const caught = await captureCode(() => launcher.launch());
    expect(caught).toBeInstanceOf(BrowserError);
    expect((caught as BrowserError).code).toBe("BROWSER_CDP_PORT_IN_USE");
    expect(spawns).toBe(0);
  });

  it("reports BROWSER_LAUNCH_FAILED when spawn emits an error", async () => {
    const child = new FakeChild();
    const launcher = new BrowserLauncher(TEST_CONFIG, {
      ensureDir: () => Promise.resolve(),
      portOccupied: () => Promise.resolve(false),
      spawnImpl: fakeSpawn(child, "error"),
    });
    const caught = await captureCode(() => launcher.launch());
    expect(caught).toBeInstanceOf(BrowserError);
    expect((caught as BrowserError).code).toBe("BROWSER_LAUNCH_FAILED");
    expect(launcher.isRunning()).toBe(false);
  });

  it("tracks a running owned process and its early exit", async () => {
    const child = new FakeChild();
    const launcher = new BrowserLauncher(TEST_CONFIG, {
      ensureDir: () => Promise.resolve(),
      portOccupied: () => Promise.resolve(false),
      spawnImpl: fakeSpawn(child, "spawn"),
    });
    await launcher.launch();
    expect(launcher.isRunning()).toBe(true);
    expect(launcher.pid).toBe(4242);
    child.exitCode = 1;
    child.emit("exit", 1, null);
    expect(launcher.isRunning()).toBe(false);
    expect(launcher.describeExit()).toContain("code=1");
  });

  it("shutdown signals only the owned child and escalates boundedly", async () => {
    const child = new FakeChild();
    const launcher = new BrowserLauncher(TEST_CONFIG, {
      ensureDir: () => Promise.resolve(),
      portOccupied: () => Promise.resolve(false),
      spawnImpl: fakeSpawn(child, "spawn"),
    });
    await launcher.launch();
    await launcher.shutdown(50);
    expect(child.killedWith[0]).toBe("SIGTERM");
    expect(child.killedWith).toContain("SIGKILL");
  });

  it("shutdown on a never-launched instance is a side-effect-free no-op", async () => {
    const launcher = new BrowserLauncher(TEST_CONFIG, {
      ensureDir: () => Promise.reject(new Error("must not run")),
    });
    await launcher.shutdown();
    expect(launcher.isRunning()).toBe(false);
  });
});
