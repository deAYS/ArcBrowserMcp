import { BridgeError } from "../../bridge/BridgeError.js";
import { McpPipeServer } from "../../bridge/mcpPipeServer.js";
import type { RelayState } from "../../bridge/mcpPipeServer.js";
import { ClientPipeRelay } from "../../bridge/clientProxy.js";
import { bridgePipeName } from "../../bridge/constants.js";
import { defaultSessionDir } from "../../bridge/session.js";
import type { Logger } from "../../utils/logger.js";

export type BridgeTransportMethod =
  | "bridge.hello"
  | "bridge.ping"
  | "bridge.status"
  | "tabs.list"
  | "tabs.open"
  | "tabs.close"
  | "tabs.activate"
  | "navigation.navigate"
  | "navigation.back"
  | "navigation.forward"
  | "navigation.reload"
  | "snapshot.capture"
  | "interaction.click"
  | "interaction.fill"
  | "interaction.type"
  | "interaction.pressKey"
  | "interaction.typeHuman"
  | "interaction.pressSequence"
  | "interaction.clickType"
  | "interaction.getText"
  | "runtime.evaluate"
  | "page.screenshot"
  | "wait.check"
  | "observability.consoleGet"
  | "observability.consoleClear"
  | "observability.networkGet"
  | "observability.networkClear";

export interface BridgeRuntimeOptions {
  readonly pipeName?: string;
  readonly sessionDir?: string;
  readonly logger?: Logger;
  /** Parent-death watchdog: forwarded to McpPipeServer (see its options). */
  readonly orphanCheckIntervalMs?: number;
  readonly isParentAlive?: (pid: number) => boolean;
  readonly onOrphaned?: () => void;
  /** Fired when the last authenticated proxy client leaves this owner. */
  readonly onClientsIdle?: () => void;
  /** Explicit clients pipe override (tests); default derives from pipeName. */
  readonly clientsPipeName?: string;
  /** Injectable pipe ACL (tests use a no-op; production applies Everyone). */
  readonly applyPipeAcl?: (pipeName: string) => Promise<void>;
  /** Bounded window for the own-or-join decision (owner still starting). */
  readonly establishTimeoutMs?: number;
  /** Backoff between own-or-join attempts. */
  readonly establishRetryMs?: number;
}

/**
 * Project-owned bridge abstraction for engine backends.
 *
 * Owns the MCP-side pipe server and session descriptor, surfaces relay
 * lifecycle events, and sends transport/health RPC. Multiple MCP processes
 * share one browser session: the first runtime to start owns the bridge pipe
 * and serves the extension relay; later runtimes join the owner through a
 * clients pipe and forward requests (the owner serializes them onto the
 * relay). When the owner disappears, a joined runtime re-runs the
 * own-or-join decision, so ownership floats without any caller-visible
 * ceremony. Knows nothing about browser tabs, CDP, or MCP tools;
 * ExtensionEngine orchestrates connect/disconnect/status on top.
 */
export class BridgeRuntime {
  private server: McpPipeServer | null = null;
  private proxy: ClientPipeRelay | null = null;
  private isStopped = false;
  private establishPromise: Promise<void> | null = null;
  private readonly relayListeners = new Set<(connected: boolean) => void>();

  constructor(private readonly options: BridgeRuntimeOptions = {}) {}

  private pipeName(): string {
    return this.options.pipeName ?? bridgePipeName(process.env["USERNAME"]);
  }

  private sessionDir(): string {
    return this.options.sessionDir ?? defaultSessionDir();
  }

  /** Subscribe to relay connectivity; returns an unsubscribe function. */
  onRelayChange(listener: (connected: boolean) => void): () => void {
    this.relayListeners.add(listener);
    return () => {
      this.relayListeners.delete(listener);
    };
  }

  private emitRelay(connected: boolean): void {
    for (const listener of [...this.relayListeners]) {
      listener(connected);
    }
  }

  async start(): Promise<void> {
    this.isStopped = false;
    await this.establish();
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    const proxy = this.proxy;
    this.proxy = null;
    proxy?.close();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await server.stop();
    }
  }

  isRelayConnected(): boolean {
    if (this.server !== null) {
      return this.server.relayState === "connected";
    }
    return this.proxy?.isRelayConnected ?? false;
  }

  /** Authenticated proxy clients joined to this process (owner mode only). */
  proxyClientCount(): number {
    return this.server?.clientCount ?? 0;
  }

  /** Own the bridge pipe, or join the active owner; bounded and idempotent. */
  private establish(): Promise<void> {
    if (this.establishPromise !== null) {
      return this.establishPromise;
    }
    this.establishPromise = this.establishLoop().finally(() => {
      this.establishPromise = null;
    });
    return this.establishPromise;
  }

  private async establishLoop(): Promise<void> {
    const deadline = Date.now() + (this.options.establishTimeoutMs ?? DEFAULT_ESTABLISH_TIMEOUT_MS);
    for (;;) {
      if (this.isStopped) {
        throw new BridgeError("NOT_CONNECTED", "bridge runtime stopped before establishment");
      }
      try {
        await this.tryOwn();
        return;
      } catch (error: unknown) {
        if (!(error instanceof BridgeError) || error.code !== "PIPE_BUSY") {
          throw error;
        }
        if (await this.tryJoin()) {
          return;
        }
      }
      if (Date.now() >= deadline) {
        throw new BridgeError(
          "PIPE_BUSY",
          `could not own the bridge pipe or join the active owner within ${String(
            this.options.establishTimeoutMs ?? DEFAULT_ESTABLISH_TIMEOUT_MS,
          )}ms`,
          { pipeName: this.pipeName() },
        );
      }
      await delayMs(Math.min(this.options.establishRetryMs ?? DEFAULT_ESTABLISH_RETRY_MS, 500));
    }
  }

  private async tryOwn(): Promise<void> {
    const server = new McpPipeServer({
      pipeName: this.pipeName(),
      sessionDir: this.sessionDir(),
      ...(this.options.logger !== undefined ? { logger: this.options.logger } : {}),
      ...(this.options.orphanCheckIntervalMs !== undefined
        ? { orphanCheckIntervalMs: this.options.orphanCheckIntervalMs }
        : {}),
      ...(this.options.isParentAlive !== undefined ? { isParentAlive: this.options.isParentAlive } : {}),
      ...(this.options.onOrphaned !== undefined ? { onOrphaned: this.options.onOrphaned } : {}),
      ...(this.options.onClientsIdle !== undefined ? { onClientsIdle: this.options.onClientsIdle } : {}),
      ...(this.options.clientsPipeName !== undefined ? { clientsPipeName: this.options.clientsPipeName } : {}),
      ...(this.options.applyPipeAcl !== undefined ? { applyPipeAcl: this.options.applyPipeAcl } : {}),
    });
    server.onRelayState((state: RelayState) => {
      this.emitRelay(state === "connected");
    });
    await server.start();
    // Re-establishment path: drop any previous objects of either mode.
    if (this.proxy !== null) {
      this.proxy.close();
      this.proxy = null;
    }
    if (this.server !== null) {
      const previous = this.server;
      this.server = null;
      await previous.stop().catch(() => undefined);
    }
    this.server = server;
    // stop() raced the bind: release immediately instead of leaking the pipe.
    if (this.isStopped) {
      const stopping = this.server;
      this.server = null;
      await stopping.stop().catch(() => undefined);
      throw new BridgeError("NOT_CONNECTED", "bridge runtime stopped during establishment");
    }
  }

  /** Returns true when this runtime joined the active owner as a proxy. */
  private async tryJoin(): Promise<boolean> {
    const proxy = new ClientPipeRelay({
      pipeName: this.clientsPipeName(),
      sessionDir: this.sessionDir(),
      ...(this.options.logger !== undefined ? { logger: this.options.logger } : {}),
      onDisconnected: () => {
        this.handleOwnerLost();
      },
    });
    // Subscribe BEFORE connect so the initial relay state can never slip
    // past this runtime between hello and registration.
    proxy.onRelayChange((connected) => {
      this.emitRelay(connected);
    });
    try {
      await proxy.connect();
    } catch {
      // Owner not reachable (starting, stopping, or never existed): the
      // establish loop retries ownership.
      return false;
    }
    if (this.isStopped) {
      proxy.close();
      return true;
    }
    if (this.server !== null) {
      const previous = this.server;
      this.server = null;
      await previous.stop().catch(() => undefined);
    }
    if (this.proxy !== null) {
      this.proxy.close();
    }
    this.proxy = proxy;
    return true;
  }

  private handleOwnerLost(): void {
    if (this.isStopped) {
      return;
    }
    this.proxy = null;
    this.emitRelay(false);
    void this.reconnectForever();
  }

  /** The owner is gone: keep re-running the own-or-join decision until one succeeds. */
  private async reconnectForever(): Promise<void> {
    while (!this.isStopped) {
      try {
        await this.establish();
        return;
      } catch {
        await delayMs(RECONNECT_RETRY_MS);
      }
    }
  }

  private clientsPipeName(): string {
    if (this.options.clientsPipeName !== undefined) {
      return this.options.clientsPipeName;
    }
    const name = this.pipeName();
    return name.includes("-bridge-v1-") ? name.replace("-bridge-v1-", "-clients-v1-") : `${name}-clients`;
  }

  async request(
    method: BridgeTransportMethod,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.proxy !== null) {
      return this.proxy.request(method, payload, timeoutMs);
    }
    const server = this.server;
    if (server === null) {
      throw new BridgeError("NOT_CONNECTED", "bridge runtime is not started");
    }
    return server.request(method, payload, timeoutMs);
  }
}

const DEFAULT_ESTABLISH_TIMEOUT_MS = 10_000;
const DEFAULT_ESTABLISH_RETRY_MS = 250;
const RECONNECT_RETRY_MS = 1_000;

function delayMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
