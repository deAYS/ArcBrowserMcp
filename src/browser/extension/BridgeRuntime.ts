import { BridgeError } from "../../bridge/BridgeError.js";
import { McpPipeServer } from "../../bridge/mcpPipeServer.js";
import type { RelayState } from "../../bridge/mcpPipeServer.js";
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
}

/**
 * Project-owned bridge abstraction for engine backends.
 *
 * Owns the MCP-side named-pipe server and session descriptor, surfaces
 * relay lifecycle events, and sends transport/health RPC. Knows nothing
 * about browser tabs, CDP, or MCP tools; ArcExtensionEngine orchestrates
 * connect/disconnect/status on top of this runtime. Reuses the proven
 * P03B transport modules instead of duplicating them.
 */
export class BridgeRuntime {
  private server: McpPipeServer | null = null;
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
    const options: { pipeName: string; sessionDir: string; logger?: Logger } = {
      pipeName: this.pipeName(),
      sessionDir: this.sessionDir(),
    };
    if (this.options.logger !== undefined) {
      options.logger = this.options.logger;
    }
    const server = new McpPipeServer(options);
    server.onRelayState((state: RelayState) => {
      this.emitRelay(state === "connected");
    });
    this.server = server;
    await server.start();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await server.stop();
    }
  }

  isRelayConnected(): boolean {
    return this.server?.relayState === "connected";
  }

  async request(
    method: BridgeTransportMethod,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    const server = this.server;
    if (server === null) {
      throw new BridgeError("NOT_CONNECTED", "bridge runtime is not started");
    }
    return server.request(method, payload, timeoutMs);
  }
}
