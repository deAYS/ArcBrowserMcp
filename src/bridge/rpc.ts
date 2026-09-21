import { randomBytes } from "node:crypto";
import { BridgeError } from "./BridgeError.js";
import type { BridgeErrorCode } from "./BridgeError.js";
import type { BridgeMessage, BridgeRequest } from "./protocol.js";
import { errorResponse, parseBridgeMessage } from "./protocol.js";

export type RpcRequestHandler = (request: BridgeRequest) => Promise<unknown>;

export interface RpcPeerOptions {
  readonly handler?: RpcRequestHandler;
  readonly defaultTimeoutMs?: number;
  readonly generateId?: () => string;
  readonly onProtocolError?: (error: BridgeError) => void;
  readonly onEvent?: (method: string, payload: Record<string, unknown>, id: string) => void;
}

const DEFAULT_RPC_TIMEOUT_MS = 15_000;

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "INVALID_ENVELOPE",
  "UNSUPPORTED_VERSION",
  "UNKNOWN_METHOD",
  "NOT_AUTHENTICATED",
  "NOT_CONNECTED",
  "TIMEOUT",
  "PIPE_BUSY",
  "SESSION_MISSING",
  "SESSION_STALE",
  "SESSION_CORRUPT",
  "ORIGIN_REJECTED",
  "NATIVE_FRAME_TOO_LARGE",
  "NATIVE_FRAME_MALFORMED",
  "NATIVE_FRAME_INCOMPLETE",
  "REGISTRY_ERROR",
  "HOST_STARTUP_FAILED",
  "EXTENSION_CONNECT_TIMEOUT",
  "BRIDGE_PREFLIGHT_FAILED",
]);

/** True when a code is a project-owned bridge error code (safe to rethrow). */
export function isKnownBridgeErrorCode(code: string): boolean {
  return KNOWN_ERROR_CODES.has(code);
}

function defaultGenerateId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Correlated request/response peer over a framed raw sender.
 *
 * Both directions share one shape: outgoing requests await responses by id
 * with bounded timeouts; incoming requests dispatch to the handler and the
 * handler result (or structured error) is sent back under the same id;
 * incoming responses with unknown ids are reported, never thrown into
 * unrelated callers. Malformed envelopes never reach the handler.
 */
export class RpcPeer {
  private readonly pending = new Map<
    string,
    { resolve: (payload: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly sendRaw: (message: BridgeMessage) => void,
    private readonly options: RpcPeerOptions = {},
  ) {}

  /** Send a raw envelope without correlation (forwarding/events). */
  send(message: BridgeMessage): void {
    this.sendRaw(message);
  }

  request(method: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    return this.requestDetailed(method, payload, timeoutMs).then((result) => result.payload);
  }

  /** Request with the correlation ID exposed for evidence/diagnostics. */
  requestDetailed(
    method: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<{ id: string; payload: unknown }> {
    if (method.trim() === "") {
      return Promise.reject(new BridgeError("INVALID_ENVELOPE", "RPC method must be non-empty"));
    }
    const id = (this.options.generateId ?? defaultGenerateId)();
    const timeout = timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    return new Promise<{ id: string; payload: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("TIMEOUT", `RPC request ${method} timed out after ${String(timeout)}ms`, { id, method }));
      }, timeout);
      this.pending.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve({ id, payload: value });
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      this.sendRaw({ version: 1, id, type: "request", method, payload });
    });
  }

  handleIncoming(raw: unknown): void {
    let message: BridgeMessage;
    try {
      message = parseBridgeMessage(raw);
    } catch (error: unknown) {
      this.options.onProtocolError?.(
        error instanceof BridgeError ? error : new BridgeError("INVALID_ENVELOPE", String(error)),
      );
      return;
    }
    if (message.type === "response") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        this.options.onProtocolError?.(
          new BridgeError("INVALID_ENVELOPE", `response for unknown request id ${message.id}`, { id: message.id }),
        );
        return;
      }
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.payload);
      } else {
        // Preserve typed codes across hops: a known transport/protocol code
        // becomes the rejection code itself (TIMEOUT must stay TIMEOUT for
        // callers that retry on it); extension-side codes stay reachable via
        // details.remoteCode. Response details pass through so typed
        // metadata survives proxy chains.
        const remoteCode = message.error.code;
        pending.reject(
          new BridgeError(
            KNOWN_ERROR_CODES.has(remoteCode) ? (remoteCode as BridgeErrorCode) : "INVALID_ENVELOPE",
            `remote error ${remoteCode}: ${message.error.message}`,
            { ...message.error.details, id: message.id, remoteCode },
          ),
        );
      }
      return;
    }
    if (message.type === "event") {
      this.options.onEvent?.(message.method, message.payload, message.id);
      return;
    }
    const handler = this.options.handler;
    if (handler === undefined) {
      this.sendRaw(errorResponse(message.id, "UNKNOWN_METHOD", `no handler for ${message.method}`));
      return;
    }
    handler(message).then(
      (payload) => {
        this.sendRaw({
          version: 1,
          id: message.id,
          type: "response",
          ok: true,
          payload: isRecord(payload) ? payload : { value: payload },
        });
      },
      (error: unknown) => {
        const code = error instanceof BridgeError ? error.code : "UNKNOWN_METHOD";
        const details = error instanceof BridgeError ? error.details : {};
        this.sendRaw(errorResponse(message.id, code, error instanceof Error ? error.message : String(error), details));
      },
    );
  }

  /** Reject every pending request (transport going away). */
  close(error?: Error): void {
    if (this.pending.size === 0) {
      return;
    }
    const failure = error ?? new BridgeError("NOT_CONNECTED", "RPC peer closed");
    const pendings = [...this.pending.values()];
    this.pending.clear();
    for (const pending of pendings) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
