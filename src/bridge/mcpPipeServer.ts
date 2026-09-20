import * as net from "node:net";
import { BridgeError } from "./BridgeError.js";
import { safeEqualString } from "./nativeHostArgs.js";
import { encodeNativeMessage, NativeFrameDecoder } from "./nativeFraming.js";
import { BRIDGE_PROTOCOL_VERSION } from "./protocol.js";
import type { BridgeMessage, BridgeRequest } from "./protocol.js";
import { RpcPeer } from "./rpc.js";
import { BRIDGE_SESSION_FILE_NAME, createSession, removeSessionFile, writeSessionAtomic } from "./session.js";
import type { BridgeSession } from "./session.js";
import { applyBridgePipeAcl } from "./pipeAcl.js";
import type { Logger } from "../utils/logger.js";

export type RelayState = "waiting" | "connected" | "closed";

export interface McpPipeServerOptions {
  readonly pipeName: string;
  readonly sessionDir: string;
  readonly sessionFileName?: string;
  readonly helloTimeoutMs?: number;
  readonly logger?: Logger;
  /**
   * Applied after listen so browser-launched (restricted-token) hosts can
   * connect. Injectable no-op in unit tests; production applies the
   * Everyone ACE (nonce auth still required after connect).
   */
  readonly applyPipeAcl?: (pipeName: string) => Promise<void>;
}

interface RelaySocket {
  readonly socket: net.Socket;
  readonly peer: RpcPeer;
  authed: boolean;
}

const DEFAULT_HELLO_TIMEOUT_MS = 15_000;

/**
 * Named-pipe endpoint owned by the active MCP process.
 *
 * One relay (the browser-launched native host) may authenticate via the
 * session nonce; unauthenticated sockets are answered once and dropped.
 * A second MCP process hitting EADDRINUSE gets a typed PIPE_BUSY error
 * instead of silently sharing the pipe. No network listeners anywhere.
 */
export class McpPipeServer {
  private server: net.Server | null = null;
  private relay: RelaySocket | null = null;
  private state: RelayState = "waiting";
  private sessionPath: string | null = null;
  private session: BridgeSession | null = null;
  private ownSession = false;
  private listenStartedAt = 0;
  private readonly stateListeners: Array<(state: RelayState) => void> = [];

  constructor(private readonly options: McpPipeServerOptions) {}

  get relayState(): RelayState {
    return this.state;
  }

  get activeSessionPath(): string | null {
    return this.sessionPath;
  }

  onRelayState(listener: (state: RelayState) => void): void {
    this.stateListeners.push(listener);
  }

  private setState(state: RelayState): void {
    this.state = state;
    for (const listener of [...this.stateListeners]) {
      listener(state);
    }
  }

  private log(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void {
    this.options.logger?.[level](message, fields);
  }

  async start(): Promise<{ pipeName: string; pid: number }> {
    const { pipeName, sessionDir } = this.options;
    const sessionPath = `${sessionDir}\\${BRIDGE_SESSION_FILE_NAME}`;
    this.sessionPath = sessionPath;
    const server = net.createServer((socket) => this.attachSocket(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: unknown) => {
        const code = (error as { code?: unknown }).code;
        if (code === "EADDRINUSE") {
          reject(
            new BridgeError("PIPE_BUSY", `named pipe ${pipeName} is already owned by another MCP process`, {
              pipeName,
            }),
          );
          return;
        }
        reject(error);
      });
      server.listen(pipeName, () => resolve());
    });
    const session = createSession(pipeName, process.pid);
    this.session = session;
    try {
      const applyAcl = this.options.applyPipeAcl ?? applyBridgePipeAcl;
      await applyAcl(pipeName);
    } catch (error: unknown) {
      this.server?.close();
      this.server = null;
      throw error;
    }
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessionDir, { recursive: true });
    await writeSessionAtomic(sessionPath, session);
    this.ownSession = true;
    this.listenStartedAt = Date.now();
    this.log("info", "bridge pipe listening", { pipeName });
    return { pipeName, pid: process.pid };
  }

  private attachSocket(socket: net.Socket): void {
    // Named-pipe decode direction is host->server: extension-originated
    // responses (including future screenshots) arrive here, so the LARGE
    // response bound applies. Requests LEAVE this server through RpcPeer
    // encoding below and stay SMALL (see RpcPeer sendRaw wrapper).
    const decoder = new NativeFrameDecoder("large-response");
    let relay: RelaySocket;
    const peer = new RpcPeer(
      (message: BridgeMessage) => {
        // Outgoing Node/server -> native-host direction: requests only,
        // always SMALL. A large envelope here is a bug, never a feature.
        socket.write(encodeNativeMessage(message, "small"));
      },
      {
        handler: (request: BridgeRequest) => this.handleRelayRequest(relay, request),
        onProtocolError: (error) => {
          this.log("warn", "bridge relay protocol error", { code: error.code });
          socket.destroy();
        },
      },
    );
    relay = { socket, peer, authed: false };
    socket.on("data", (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch (error: unknown) {
        this.log("warn", "bridge relay framing error", {
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
      peer.close(new BridgeError("NOT_CONNECTED", "bridge relay disconnected"));
      if (this.relay === relay) {
        this.relay = null;
        if (this.state === "connected") {
          this.setState("waiting");
          this.log("info", "bridge relay disconnected");
        }
      }
    });
    socket.on("error", () => {
      socket.destroy();
    });
    const helloTimeout = this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    setTimeout(() => {
      if (!relay.authed) {
        socket.destroy();
      }
    }, helloTimeout).unref?.();
  }

  private async handleRelayRequest(relay: RelaySocket, request: BridgeRequest): Promise<unknown> {
    if (request.method === "bridge.hello") {
      const nonce = request.payload["nonce"];
      const version = request.payload["bridgeVersion"];
      if (typeof nonce !== "string" || !safeEqualString(nonce, this.currentNonce())) {
        setImmediate(() => relay.socket.destroy());
        throw new BridgeError("NOT_AUTHENTICATED", "bridge hello presented an invalid session nonce");
      }
      if (version !== BRIDGE_PROTOCOL_VERSION) {
        setImmediate(() => relay.socket.destroy());
        throw new BridgeError(
          "UNSUPPORTED_VERSION",
          `bridge hello version ${JSON.stringify(version)} is not supported`,
        );
      }
      if (this.relay !== null && this.relay !== relay) {
        setImmediate(() => relay.socket.destroy());
        throw new BridgeError("NOT_CONNECTED", "bridge already has an authenticated relay");
      }
      relay.authed = true;
      this.relay = relay;
      this.setState("connected");
      this.log("info", "bridge relay authenticated", { relayWaitMs: Date.now() - this.listenStartedAt });
      return { ok: true, bridgeVersion: BRIDGE_PROTOCOL_VERSION, mcpPid: process.pid };
    }
    if (!relay.authed) {
      setImmediate(() => relay.socket.destroy());
      throw new BridgeError("NOT_AUTHENTICATED", "bridge request before authenticated hello");
    }
    throw new BridgeError("UNKNOWN_METHOD", `MCP side does not serve ${request.method}`);
  }

  private currentNonce(): string {
    // Empty never matches: hello before start() completed is rejected.
    return this.session?.nonceHex ?? "";
  }

  /** Outgoing request toward the extension via the authenticated relay. */
  async request(method: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const result = await this.requestDetailed(method, payload, timeoutMs);
    return result.payload;
  }

  /** Outgoing request with the correlation ID exposed for evidence. */
  async requestDetailed(
    method: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<{ id: string; payload: unknown }> {
    const relay = this.relay;
    if (relay === null || !relay.authed) {
      throw new BridgeError("NOT_CONNECTED", "no authenticated bridge relay is connected");
    }
    return relay.peer.requestDetailed(method, payload, timeoutMs);
  }

  async stop(): Promise<void> {
    this.setState("closed");
    const relay = this.relay;
    this.relay = null;
    relay?.peer.close(new BridgeError("NOT_CONNECTED", "bridge server stopping"));
    relay?.socket.destroy();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    if (this.ownSession && this.sessionPath !== null) {
      await removeSessionFile(this.sessionPath);
      this.ownSession = false;
    }
  }
}
