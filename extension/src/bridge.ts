/**
 * Extension-side bridge client.
 *
 * Owns the long-lived chrome.runtime.connectNative port to
 * com.arc_mcp.bridge. Handles correlation for extension-answered requests
 * (bridge.ping/hello/status from MCP), bounded exponential reconnect, and
 * minimal status. No browser business logic beyond answering the three
 * transport/health primitives.
 */

export const BRIDGE_HOST_NAME = "com.arc_mcp.bridge";
export const BRIDGE_PROTOCOL_VERSION = 1;

export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage(listener: (message: unknown) => void): void;
  onDisconnect(listener: () => void): void;
  lastError(): string | undefined;
}

export type ConnectNativeFn = (hostName: string) => NativePort;

export type RemoteRequestHandler = (
  method: string,
  payload: Record<string, unknown>,
  id: string,
) => Promise<unknown> | unknown;

export interface BridgeStatus {
  readonly connected: boolean;
  readonly attempts: number;
  readonly lastError: string | null;
  /** Which trigger started the current/last connection attempt (wake-cause tracking). */
  readonly lastWakeSource: string | null;
}

export interface BridgeClientOptions {
  readonly hostName?: string;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly requestTimeoutMs?: number;
  readonly generateId?: () => string;
}

/** Pure backoff schedule: base doubling capped at max (attempts from 0). */
export function reconnectDelayMs(attempt: number, baseMs = 500, maxMs = 10_000): number {
  let delay = baseMs;
  for (let i = 0; i < attempt; i += 1) {
    delay = Math.min(delay * 2, maxMs);
    if (delay >= maxMs) {
      break;
    }
  }
  return Math.min(delay, maxMs);
}

function defaultGenerateId(): string {
  return crypto.randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class ExtensionBridge {
  private port: NativePort | null = null;
  private connecting = false;
  private attempts = 0;
  private lastError: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastWakeSource: string | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private requestHandler: RemoteRequestHandler | null = null;

  /** Single dispatch owner: background.ts registers once for bridge/tabs/navigation methods. */
  constructor(
    private readonly connectNative: ConnectNativeFn,
    private readonly options: BridgeClientOptions = {},
  ) {}

  getStatus(): BridgeStatus {
    return { connected: this.port !== null, attempts: this.attempts, lastError: this.lastError, lastWakeSource: this.lastWakeSource };
  }

  onRemoteRequest(handler: RemoteRequestHandler): void {
    if (this.requestHandler !== null) {
      throw new Error("bridge request handler already registered");
    }
    this.requestHandler = handler;
  }

  /** Connect now unless already connected/connecting. Safe to call often. */
  ensureConnected(source = "unknown"): void {
    if (this.closed || this.port !== null || this.connecting) {
      return;
    }
    this.lastWakeSource = source;
    this.connecting = true;
    try {
      const port = this.connectNative(this.options.hostName ?? BRIDGE_HOST_NAME);
      port.onMessage((message: unknown) => this.handleNativeMessage(message));
      port.onDisconnect(() => this.handleDisconnect(port));
      this.port = port;
      this.connecting = false;
      this.lastError = null;
    } catch (error: unknown) {
      this.connecting = false;
      this.handleFailure(error instanceof Error ? error.message : String(error));
    }
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const port = this.port;
    this.port = null;
    try {
      port?.disconnect();
    } catch {
      // Already gone; status already reflects disconnection.
    }
    this.failPending(new Error("bridge closed"));
  }

  /** Extension-initiated request toward MCP (kept tiny). */
  request(method: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const port = this.port;
    if (port === null) {
      return Promise.reject(new Error("bridge not connected"));
    }
    const id = (this.options.generateId ?? defaultGenerateId)();
    const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 15_000;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge request ${method} timed out`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      port.postMessage({ version: BRIDGE_PROTOCOL_VERSION, id, type: "request", method, payload });
    });
  }

  private failPending(error: Error): void {
    if (this.pending.size === 0) {
      return;
    }
    const pendings = [...this.pending.values()];
    this.pending.clear();
    for (const pending of pendings) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private handleFailure(message: string): void {
    this.lastError = message;
    this.attempts += 1;
    this.scheduleReconnect();
  }

  private handleDisconnect(port: NativePort): void {
    if (this.port !== port) {
      return;
    }
    this.port = null;
    this.failPending(new Error("bridge disconnected"));
    const error = port.lastError() ?? "native host disconnected";
    this.handleFailure(error);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer !== null) {
      return;
    }
    const delay = reconnectDelayMs(
      this.attempts,
      this.options.baseDelayMs ?? 500,
      this.options.maxDelayMs ?? 10_000,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.ensureConnected("retry");
    }, delay);
  }

  private handleNativeMessage(message: unknown): void {
    if (!isRecord(message) || message["version"] !== BRIDGE_PROTOCOL_VERSION) {
      this.lastError = "bridge protocol version mismatch";
      return;
    }
    const id = typeof message["id"] === "string" ? message["id"] : null;
    if (id === null) {
      return;
    }
    if (message["type"] === "response") {
      const pending = this.pending.get(id);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message["ok"] === true) {
        pending.resolve(isRecord(message["payload"]) ? message["payload"] : {});
      } else {
        const error = isRecord(message["error"]) && typeof message["error"]["message"] === "string"
          ? String(message["error"]["message"])
          : "remote error";
        pending.reject(new Error(error));
      }
      return;
    }
    if (message["type"] !== "request" || typeof message["method"] !== "string") {
      return;
    }
    const payload = isRecord(message["payload"]) ? message["payload"] : {};
    const port = this.port;
    const handler = this.requestHandler;
    if (port === null || handler === null) {
      return;
    }
    Promise.resolve()
      .then(() => handler(message["method"] as string, payload, id))
      .then(
        (result) => {
          port.postMessage({
            version: BRIDGE_PROTOCOL_VERSION,
            id,
            type: "response",
            ok: true,
            payload: isRecord(result) ? result : { value: result },
          });
        },
        (error: unknown) => {
          // Preserve typed extension-side codes (TabError.code, e.g.
          // TAB_NOT_FOUND) so Node can map to the project error taxonomy.
          // Untyped failures stay UNKNOWN_METHOD.
          let code = "UNKNOWN_METHOD";
          if (isRecord(error) && typeof error["code"] === "string" && error["code"] !== "") {
            code = error["code"];
          }
          port.postMessage({
            version: BRIDGE_PROTOCOL_VERSION,
            id,
            type: "response",
            ok: false,
            error: { code, message: error instanceof Error ? error.message : String(error) },
          });
        },
      );
  }
}
