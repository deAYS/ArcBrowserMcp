import * as net from "node:net";
import { readFile } from "node:fs/promises";
import { BridgeError } from "./BridgeError.js";
import type { BridgeErrorCode } from "./BridgeError.js";
import { encodeNativeMessage, NativeFrameDecoder } from "./nativeFraming.js";
import { BRIDGE_PROTOCOL_VERSION, parseBridgeMessage } from "./protocol.js";
import type { BridgeMessage } from "./protocol.js";
import { RpcPeer } from "./rpc.js";
import { isKnownBridgeErrorCode } from "./rpc.js";
import { BRIDGE_SESSION_FILE_NAME, defaultIsPidAlive, isSessionStale, loadSessionDescriptor } from "./session.js";
import type { BridgeSession } from "./session.js";
import type { Logger } from "../utils/logger.js";

export interface ClientPipeRelayOptions {
  /** The OWNER's clients pipe (not the extension bridge pipe). */
  readonly pipeName: string;
  readonly sessionDir: string;
  readonly logger?: Logger;
  readonly helloTimeoutMs?: number;
  /** Injectable for unit tests; production uses a real pipe connection. */
  readonly connectPipe?: (pipeName: string) => Promise<net.Socket>;
  /** Injectable session loader for unit tests. */
  readonly loadSession?: () => Promise<BridgeSession | null>;
  /** Fired when the owner-side connection drops after a successful hello. */
  readonly onDisconnected?: () => void;
}

const DEFAULT_HELLO_TIMEOUT_MS = 15_000;
const RELAY_STATE_EVENT_METHOD = "bridge.relayState";
const CLIENT_HELLO_ID = "client-hello";

/**
 * MCP-side proxy client: one extra MCP process joined to the active owner's
 * extension relay. Authenticates with the shared session nonce, forwards
 * typed bridge requests verbatim, and mirrors relay-state events so the
 * local engine status stays truthful. Holds no browser state of its own.
 */
export class ClientPipeRelay {
  private socket: net.Socket | null = null;
  private peer: RpcPeer | null = null;
  private relayUp = false;
  private closed = false;
  private readonly relayListeners = new Set<(connected: boolean) => void>();

  constructor(private readonly options: ClientPipeRelayOptions) {}

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

  get isRelayConnected(): boolean {
    return this.peer !== null && this.relayUp;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new BridgeError("NOT_CONNECTED", "client pipe relay is closed");
    }
    const session = await this.loadSession();
    const socket = await this.connectPipe(this.options.pipeName);
    const decoder = new NativeFrameDecoder("large-response");
    const peer = new RpcPeer(
      (message: BridgeMessage) => {
        // Client -> owner direction: requests only, always SMALL.
        try {
          socket.write(encodeNativeMessage(message, "small"));
        } catch (error: unknown) {
          this.log("warn", "bridge client send failed", {
            code: error instanceof BridgeError ? error.code : "UNKNOWN",
          });
          socket.destroy();
        }
      },
      {
        onEvent: (method, payload) => {
          if (method !== RELAY_STATE_EVENT_METHOD) {
            return;
          }
          this.relayUp = payload["connected"] === true;
          this.emitRelay(this.relayUp);
        },
        onProtocolError: (error) => {
          // Unknown-id responses are routine (local timeout races a slow
          // owner forward): keep the connection. Structural errors fail closed.
          if (error.details["id"] === undefined) {
            this.log("warn", "bridge client protocol error", { code: error.code });
            socket.destroy();
          }
        },
      },
    );
    socket.on("data", (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch (error: unknown) {
        this.log("warn", "bridge client framing error", {
          code: error instanceof BridgeError ? error.code : "UNKNOWN",
        });
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        peer.handleIncoming(frame);
      }
    });
    socket.on("close", () => {
      peer.close(new BridgeError("NOT_CONNECTED", "bridge owner disconnected"));
      if (this.socket === socket) {
        this.socket = null;
        this.peer = null;
      }
      this.setRelayUp(false);
      // A deliberate close() is not owner loss; never trigger reconnects.
      if (!this.closed) {
        this.options.onDisconnected?.();
      }
    });
    socket.on("error", () => {
      socket.destroy();
    });

    const helloOutcome = await this.hello(socket, decoder, session.nonceHex);
    if (!helloOutcome.ok) {
      socket.destroy();
      throw helloOutcome.error ?? new BridgeError("NOT_CONNECTED", "bridge client hello failed");
    }
    if (helloOutcome.bridgeVersion !== BRIDGE_PROTOCOL_VERSION) {
      socket.destroy();
      throw new BridgeError(
        "UNSUPPORTED_VERSION",
        `owner bridge version ${JSON.stringify(helloOutcome.bridgeVersion)} is not supported`,
      );
    }
    this.socket = socket;
    this.peer = peer;
    this.relayUp = helloOutcome.relayConnected;
    this.log("info", "bridge proxy joined owner", { ownerPid: helloOutcome.mcpPid, relayConnected: this.relayUp });
    this.emitRelay(this.relayUp);
  }

  private setRelayUp(connected: boolean): void {
    if (this.relayUp !== connected) {
      this.relayUp = connected;
      this.emitRelay(connected);
    }
  }

  private async hello(
    socket: net.Socket,
    decoder: NativeFrameDecoder,
    nonceHex: string,
  ): Promise<{ ok: true; bridgeVersion: number; mcpPid: number; relayConnected: boolean } | { ok: false; error?: BridgeError }> {
    const timeoutMs = this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        socket.off("data", onData);
        resolve({ ok: false, error: new BridgeError("TIMEOUT", "bridge client hello timed out") });
      }, timeoutMs);
      const onData = (chunk: Buffer): void => {
        let frames: unknown[];
        try {
          frames = decoder.push(chunk);
        } catch (error: unknown) {
          clearTimeout(timer);
          socket.off("data", onData);
          resolve({
            ok: false,
            error: new BridgeError(
              "INVALID_ENVELOPE",
              `framing error during client hello: ${error instanceof Error ? error.message : String(error)}`,
            ),
          });
          return;
        }
        for (const frame of frames) {
          let message: BridgeMessage;
          try {
            message = parseBridgeMessage(frame);
          } catch (error: unknown) {
            clearTimeout(timer);
            socket.off("data", onData);
            resolve({
              ok: false,
              error: new BridgeError(
                "INVALID_ENVELOPE",
                `protocol error during client hello: ${error instanceof Error ? error.message : String(error)}`,
              ),
            });
            return;
          }
          if (message.type !== "response" || message.id !== CLIENT_HELLO_ID) {
            continue;
          }
          clearTimeout(timer);
          socket.off("data", onData);
          if (message.ok) {
            const payload = message.payload;
            const bridgeVersion = payload["bridgeVersion"];
            const mcpPid = payload["mcpPid"];
            resolve({
              ok: true,
              bridgeVersion: typeof bridgeVersion === "number" ? bridgeVersion : -1,
              mcpPid: typeof mcpPid === "number" ? mcpPid : 0,
              relayConnected: payload["relayConnected"] === true,
            });
          } else {
            const code = isKnownBridgeErrorCode(message.error.code) ? message.error.code : "NOT_CONNECTED";
            resolve({
              ok: false,
              error: new BridgeError(code as BridgeErrorCode, message.error.message),
            });
          }
          return;
        }
      };
      socket.on("data", onData);
      socket.write(
        encodeNativeMessage(
          {
            version: BRIDGE_PROTOCOL_VERSION,
            id: CLIENT_HELLO_ID,
            type: "request",
            method: "bridge.hello",
            payload: { nonce: nonceHex, bridgeVersion: BRIDGE_PROTOCOL_VERSION },
          },
          "small",
        ),
      );
    });
  }

  private async loadSession(): Promise<BridgeSession> {
    const loader =
      this.options.loadSession ??
      (() =>
        loadSessionDescriptor(
          (path) => readFile(path, "utf-8"),
          `${this.options.sessionDir}\\${BRIDGE_SESSION_FILE_NAME}`,
        ));
    const session = await loader();
    if (session === null) {
      throw new BridgeError("SESSION_MISSING", "no active bridge session to join; is the owning MCP process running?");
    }
    if (isSessionStale(session, defaultIsPidAlive)) {
      throw new BridgeError("SESSION_STALE", "bridge session is stale (owner process gone); waiting for a fresh one");
    }
    return session;
  }

  private connectPipe(pipeName: string): Promise<net.Socket> {
    const connect = this.options.connectPipe;
    if (connect !== undefined) {
      return connect(pipeName);
    }
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(pipeName);
      socket.once("connect", () => resolve(socket));
      socket.once("error", (error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private log(level: "info" | "warn", message: string, fields?: Record<string, unknown>): void {
    this.options.logger?.[level](message, fields);
  }

  /** Outgoing request toward the extension via the owning process. */
  async request(method: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const peer = this.peer;
    if (peer === null) {
      throw new BridgeError("NOT_CONNECTED", "no authenticated bridge owner is connected");
    }
    return peer.request(method, payload, timeoutMs);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    this.peer?.close(new BridgeError("NOT_CONNECTED", "client pipe relay closing"));
    this.peer = null;
    socket?.destroy();
    this.setRelayUp(false);
  }
}
