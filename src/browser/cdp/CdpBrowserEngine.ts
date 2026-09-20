import type { ArcLaunchConfig } from "../arc/ArcLaunchConfig.js";
import { buildArcLaunchConfig } from "../arc/ArcLaunchConfig.js";
import { ArcLauncher } from "../arc/ArcLauncher.js";
import { discoverArcExecutable } from "../arc/ArcDiscovery.js";
import type { ArcDiscoveryResult } from "../arc/ArcDiscovery.js";
import { resolveMcpProfilePath } from "../arc/ArcProfile.js";
import { ArcError, browserOperationNotImplemented } from "../../errors/ArcError.js";
import type { BrowserEngine } from "../BrowserEngine.js";
import type {
  BrowserStatus,
  BrowserTab,
  ConsoleClearResult,
  ConsoleResult,
  ElementRef,
  EvaluateOptions,
  EvaluateResult,
  NavigateRequest,
  NavigateResult,
  NetworkClearResult,
  NetworkResult,
  ScreenshotOptions,
  ScreenshotResult,
  SnapshotOptions,
  SnapshotResult,
  TabId,
  WaitCondition,
  WaitResult,
} from "../models.js";
import { CdpConnection } from "./CdpConnection.js";
import { DEFAULT_READINESS_OPTIONS, waitForCdpReady } from "./CdpReadiness.js";
import type { CdpVersionInfo } from "./CdpReadiness.js";

export interface CdpEngineOptions {
  /** Explicit executable override; undefined means auto-discover at connect(). */
  readonly executablePath: string | undefined;
  /** Explicit profile override; undefined means the stable per-user default. */
  readonly profilePath: string | undefined;
  readonly debugPort: number;
  readonly readinessTimeoutMs?: number;
}

export interface CdpEngineDeps {
  readonly discover?: (explicitPath: string | undefined) => Promise<ArcDiscoveryResult>;
  readonly createLauncher?: (config: ArcLaunchConfig) => ArcLauncher;
  readonly createConnection?: () => CdpConnection;
  readonly waitReady?: (port: number, isAlive: () => boolean, describeExit: () => string) => Promise<CdpVersionInfo>;
}

const GRACEFUL_CLOSE_TIMEOUT_MS = 10_000;

/**
 * BrowserEngine backend for the dedicated Arc process over CDP (P03).
 *
 * Owns launcher, readiness, and connection lifecycle. Only connect,
 * disconnect, and status are functional; every future-phase operation is an
 * explicit side-effect-free not-implemented stub so the public contract
 * never changes shape for P04+.
 */
export class CdpBrowserEngine implements BrowserEngine {
  private state: "disconnected" | "connecting" | "connected" | "error" = "disconnected";
  private launcher: ArcLauncher | null = null;
  private connection: CdpConnection | null = null;
  private launchConfig: ArcLaunchConfig | null = null;
  private discoverySource: string | null = null;
  private lastErrorCode: string | null = null;

  constructor(
    private readonly options: CdpEngineOptions,
    private readonly deps: CdpEngineDeps = {},
  ) {}

  private notImplemented(operation: string): Promise<never> {
    return Promise.reject(browserOperationNotImplemented(operation));
  }

  async connect(): Promise<void> {
    if (this.state === "connected") {
      return;
    }
    this.state = "connecting";
    this.lastErrorCode = null;
    try {
      const discover =
        this.deps.discover ??
        ((explicitPath: string | undefined) =>
          explicitPath === undefined
            ? discoverArcExecutable({})
            : discoverArcExecutable({ explicitPath }));
      const discovery = await discover(this.options.executablePath);
      const profilePath = resolveMcpProfilePath(this.options.profilePath);
      const config = buildArcLaunchConfig({
        executablePath: discovery.executablePath,
        profilePath,
        debugPort: this.options.debugPort,
        arcInstallDirs: discovery.installLocation === undefined ? [] : [discovery.installLocation],
      });
      const createLauncher = this.deps.createLauncher ?? ((c: ArcLaunchConfig) => new ArcLauncher(c));
      const launcher = createLauncher(config);
      this.launcher = launcher;
      await launcher.launch();

      const createConnection = this.deps.createConnection ?? (() => new CdpConnection());
      const connection = createConnection();
      this.connection = connection;
      connection.onDisconnected(() => this.handleRemoteDisconnect());

      const waitReady =
        this.deps.waitReady ??
        ((port: number, isAlive: () => boolean, describeExit: () => string) =>
          waitForCdpReady(port, {
            ...DEFAULT_READINESS_OPTIONS,
            timeoutMs: this.options.readinessTimeoutMs ?? DEFAULT_READINESS_OPTIONS.timeoutMs,
            isAlive,
            describeExit,
          }));
      await waitReady(config.debugPort, () => launcher.isRunning(), () => launcher.describeExit());
      await connection.connect(config.debugPort);

      this.launchConfig = config;
      this.discoverySource = discovery.source;
      this.state = "connected";
    } catch (error: unknown) {
      this.lastErrorCode = error instanceof ArcError ? error.code : "ARC_LAUNCH_FAILED";
      this.state = "error";
      await this.cleanupOwned();
      throw error;
    }
  }

  private handleRemoteDisconnect(): void {
    if (this.state !== "connected") {
      return;
    }
    this.connection = null;
    this.state = "disconnected";
  }

  private async cleanupOwned(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (connection !== null) {
      await connection.release();
    }
    const launcher = this.launcher;
    this.launcher = null;
    if (launcher !== null && launcher.isRunning()) {
      await launcher.shutdown();
    }
  }

  /** PID of the owned dedicated Arc process, or null when none is running. */
  getOwnedPid(): number | null {
    return this.launcher?.pid ?? null;
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    const launcher = this.launcher;
    this.connection = null;
    this.launcher = null;
    if (connection !== null) {
      await connection.gracefulBrowserClose(GRACEFUL_CLOSE_TIMEOUT_MS);
    }
    if (launcher !== null && launcher.isRunning()) {
      await launcher.shutdown();
    }
    if (connection !== null) {
      await connection.release();
    }
    this.state = "disconnected";
  }

  async status(): Promise<BrowserStatus> {
    const live = this.connection?.isConnected() ?? false;
    const connected = this.state === "connected" && live;
    const state = connected ? "connected" : this.state === "connected" ? "disconnected" : this.state;
    const status: BrowserStatus = {
      connected,
      state,
      backend: "cdp",
      profileMode: "dedicated-mcp-profile",
      selectedTabId: null,
    };
    if (state === "connecting") {
      return { ...status, reason: "browser-connect-in-progress" };
    }
    if (state === "error") {
      const reason = this.lastErrorCode ?? "browser-error";
      const withReason: BrowserStatus = { ...status, reason };
      return this.lastErrorCode === null ? withReason : { ...withReason, lastErrorCode: this.lastErrorCode };
    }
    if (!connected) {
      return { ...status, reason: "browser-not-connected" };
    }
    const port = this.launchConfig?.debugPort ?? this.options.debugPort;
    const withPort: BrowserStatus = { ...status, cdpPort: port };
    const withSource =
      this.discoverySource === null ? withPort : { ...withPort, discoverySource: this.discoverySource };
    const count = this.connection?.contextCount() ?? 0;
    return { ...withSource, contextCount: count };
  }

  async listTabs(): Promise<BrowserTab[]> {
    return this.notImplemented("listTabs");
  }

  async selectTab(_tabId: TabId): Promise<void> {
    return this.notImplemented("selectTab");
  }

  async openTab(_url?: string): Promise<BrowserTab> {
    return this.notImplemented("openTab");
  }

  async closeTab(_tabId: TabId): Promise<void> {
    return this.notImplemented("closeTab");
  }

  async navigate(_request: NavigateRequest): Promise<NavigateResult> {
    return this.notImplemented("navigate");
  }

  async goBack(): Promise<void> {
    return this.notImplemented("goBack");
  }

  async goForward(): Promise<void> {
    return this.notImplemented("goForward");
  }

  async reload(_ignoreCache?: boolean): Promise<void> {
    return this.notImplemented("reload");
  }

  async snapshot(_options?: SnapshotOptions): Promise<SnapshotResult> {
    return this.notImplemented("snapshot");
  }

  async click(_ref: ElementRef): Promise<void> {
    return this.notImplemented("click");
  }

  async fill(_ref: ElementRef, _text: string): Promise<void> {
    return this.notImplemented("fill");
  }

  async type(_ref: ElementRef, _text: string): Promise<void> {
    return this.notImplemented("type");
  }

  async pressKey(_key: string): Promise<void> {
    return this.notImplemented("pressKey");
  }

  async getText(_ref?: ElementRef): Promise<string> {
    return this.notImplemented("getText");
  }

  async evaluate(_expression: string, _options?: EvaluateOptions): Promise<EvaluateResult> {
    return this.notImplemented("evaluate");
  }

  async screenshot(_options?: ScreenshotOptions): Promise<ScreenshotResult> {
    return this.notImplemented("screenshot");
  }

  async waitFor(_condition: WaitCondition): Promise<WaitResult> {
    return this.notImplemented("waitFor");
  }

  async getConsole(_limit?: number): Promise<ConsoleResult> {
    return this.notImplemented("getConsole");
  }

  async clearConsole(): Promise<ConsoleClearResult> {
    return this.notImplemented("clearConsole");
  }

  async getNetwork(_limit?: number): Promise<NetworkResult> {
    return this.notImplemented("getNetwork");
  }

  async clearNetwork(): Promise<NetworkClearResult> {
    return this.notImplemented("clearNetwork");
  }
}
