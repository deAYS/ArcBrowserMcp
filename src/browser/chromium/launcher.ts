import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import type { ChromiumLaunchConfig } from "./launchConfig.js";
import { launchFailed, cdpPortInUse } from "../../errors/BrowserError.js";
import { CDP_LOOPBACK_HOST, isTcpPortOccupied } from "../cdp/CdpReadiness.js";

export type SpawnFn = typeof spawn;

export interface BrowserLauncherDeps {
  readonly spawnImpl?: SpawnFn;
  readonly ensureDir?: (dir: string) => Promise<void>;
  readonly portOccupied?: (host: string, port: number) => Promise<boolean>;
}

export interface BrowserExitInfo {
  readonly code: number | null;
  readonly signal: string | null;
}

/**
 * Owns exactly one dedicated browser process: the instance this process
 * spawned.
 *
 * Never touches unrelated processes: shutdown signals only the retained
 * child handle, and launch refuses an already-occupied CDP port instead of
 * attaching to or killing whatever owns it.
 */
export class BrowserLauncher {
  private child: ChildProcess | null = null;
  private spawnFailed = false;
  private exitInfo: BrowserExitInfo | null = null;
  private readonly exitListeners: Array<() => void> = [];

  constructor(
    private readonly config: ChromiumLaunchConfig,
    private readonly deps: BrowserLauncherDeps = {},
  ) {}

  get launchConfig(): ChromiumLaunchConfig {
    return this.config;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  isRunning(): boolean {
    return this.child !== null && !this.spawnFailed && this.child.exitCode === null;
  }

  describeExit(): string {
    if (this.exitInfo === null) {
      return this.spawnFailed ? "spawn failed" : "still running";
    }
    return `code=${String(this.exitInfo.code)} signal=${String(this.exitInfo.signal)}`;
  }

  onExit(listener: () => void): void {
    if (this.exitInfo !== null) {
      listener();
      return;
    }
    this.exitListeners.push(listener);
  }

  private recordExit(code: number | null, signal: string | null): void {
    this.exitInfo = { code, signal };
    const listeners = this.exitListeners.splice(0, this.exitListeners.length);
    for (const listener of listeners) {
      listener();
    }
  }

  async launch(): Promise<void> {
    const ensureDir = this.deps.ensureDir ?? (async (dir: string) => {
      await fs.mkdir(dir, { recursive: true });
    });
    try {
      await ensureDir(this.config.profilePath);
    } catch (error: unknown) {
      throw launchFailed(`cannot create dedicated profile directory ${this.config.profilePath}`, error);
    }

    const portOccupied = this.deps.portOccupied ?? isTcpPortOccupied;
    if (await portOccupied(CDP_LOOPBACK_HOST, this.config.debugPort)) {
      throw cdpPortInUse(this.config.debugPort);
    }

    const spawnImpl = this.deps.spawnImpl ?? spawn;
    let child: ChildProcess;
    try {
      // No shell, fixed executable, array arguments only.
      child = spawnImpl(this.config.executablePath, [...this.config.args], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error: unknown) {
      throw launchFailed(`spawn threw for ${this.config.executablePath}`, error);
    }
    this.child = child;
    child.once("error", () => {
      this.spawnFailed = true;
      this.recordExit(null, null);
    });
    child.once("exit", (code: number | null, signal: string | null) => {
      this.recordExit(code, signal);
    });
    // Async spawn failures (e.g. missing executable) surface via 'error'.
    // Give the event loop a turn so a synchronous-feeling failure rejects here.
    await new Promise<void>((resolve, reject) => {
      child.once("error", (error: unknown) => {
        reject(launchFailed(`failed to spawn ${this.config.executablePath}`, error));
      });
      child.once("spawn", () => resolve());
    });
  }

  private waitForExitBounded(timeoutMs: number): Promise<void> {
    if (!this.isRunning()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      this.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Terminate only the owned child (SIGTERM, then SIGKILL after a bound).
   * Resolves once the child is gone or the bounds expire; never touches any
   * other process.
   */
  async shutdown(gracefulTimeoutMs = 5_000): Promise<void> {
    const child = this.child;
    if (child === null || !this.isRunning()) {
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone (ESRCH) or unsignallable: fall through to bounded wait.
    }
    await this.waitForExitBounded(gracefulTimeoutMs);
    if (this.isRunning()) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort against the owned handle only.
      }
      await this.waitForExitBounded(gracefulTimeoutMs);
    }
  }
}
