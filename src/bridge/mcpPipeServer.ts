import * as net from "node:net";
import { readFile } from "node:fs/promises";
import { BridgeError } from "./BridgeError.js";
import { safeEqualString } from "./nativeHostArgs.js";
import { encodeNativeMessage, NativeFrameDecoder } from "./nativeFraming.js";
import { BRIDGE_PROTOCOL_VERSION } from "./protocol.js";
import type { BridgeMessage, BridgeRequest } from "./protocol.js";
import { RpcPeer } from "./rpc.js";
import { BRIDGE_SESSION_FILE_NAME, createSession, defaultIsPidAlive, isSessionStale, loadSessionDescriptor, removeSessionFile, writeSessionAtomic } from "./session.js";
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
  /**
   * Parent-death watchdog: when opencode is killed without reaping its MCP
   * child, the orphan would otherwise hold the pipe forever and every later
   * session fails PIPE_BUSY. Armed only when onOrphaned is set; production
   * wires it to process shutdown. Never removes another owner's session.
   * Deferred while authenticated proxy clients are still connected: they
   * re-establish ownership on their own once this owner exits.
   */
  readonly parentPid?: number;
  readonly orphanCheckIntervalMs?: number;
  readonly isParentAlive?: (pid: number) => boolean;
  readonly onOrphaned?: () => void;
  /**
   * Second per-user pipe for MCP-side proxy clients (extra MCP processes
   * sharing this process's extension relay). Requests are authenticated
   * with the same session nonce and forwarded to the relay; responses and
   * relay-state events flow back. Absent name disables the client listener
   * (unit tests that only exercise the relay path).
   */
  readonly clientsPipeName?: string;
  /** Fired when the last authenticated proxy client disconnects. */
  readonly onClientsIdle?: () => void;
}

interface RelaySocket {
  readonly socket: net.Socket;
  readonly peer: RpcPeer;
  authed: boolean;
}

interface ClientSocket {
  readonly socket: net.Socket;
  peer: RpcPeer;
  authed: boolean;
}

const DEFAULT_HELLO_TIMEOUT_MS = 15_000;
const DEFAULT_ORPHAN_CHECK_INTERVAL_MS = 5_000;
/**
 * Bound for owner-side forwarding to the extension relay. The proxy client
 * enforces its own (shorter, caller-supplied) timeout; this is only the
 * leak bound for forwards whose client vanished mid-request.
 */
const CLIENT_FORWARD_TIMEOUT_MS = 120_000;
const RELAY_STATE_EVENT_METHOD = "bridge.relayState";

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
  private clientsServer: net.Server | null = null;
  private relay: RelaySocket | null = null;
  private readonly clients = new Set<ClientSocket>();
  private state: RelayState = "waiting";
  private sessionPath: string | null = null;
  private session: BridgeSession | null = null;
  private ownSession = false;
  private listenStartedAt = 0;
  private orphanTimer: ReturnType<typeof setInterval> | null = null;
  private orphanPending = false;
  private readonly stateListeners: Array<(state: RelayState) => void> = [];

  constructor(private readonly options: McpPipeServerOptions) {}

  get relayState(): RelayState {
    return this.state;
  }

  /** Authenticated proxy clients currently joined to this owner. */
  get clientCount(): number {
    return this.clients.size;
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
    this.pushRelayStateEvent();
  }

  /** Best-effort relay-state push to every authenticated proxy client. */
  private pushRelayStateEvent(): void {
    for (const client of [...this.clients]) {
      try {
        client.peer.send({
          version: 1,
          id: "relay-state",
          type: "event",
          method: RELAY_STATE_EVENT_METHOD,
          payload: { connected: this.state === "connected" },
        });
      } catch {
        // Undeliverable event: the socket-level error/close handlers reap it.
      }
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
    try {
      await this.listenOnPipe(server, pipeName);
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== "EADDRINUSE" || !(await this.clearStaleSessionFile(sessionPath))) {
        this.server = null;
        throw this.asPipeBusy(pipeName, error);
      }
      // Conflicting session was absent/corrupt/stale (crash or
      // stop-in-progress race): retry once, then fail as busy.
      try {
        await this.listenOnPipe(server, pipeName);
      } catch (retryError: unknown) {
        this.server = null;
        throw this.asPipeBusy(pipeName, retryError);
      }
    }
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
    // Proxy clients join AFTER the session file exists: their hello reads
    // the same nonce, so binding the clients pipe first would race them.
    const clientsPipeName = this.clientsPipeName();
    if (clientsPipeName !== null) {
      const clientsServer = net.createServer((socket) => this.attachClientSocket(socket));
      this.clientsServer = clientsServer;
      try {
        await this.listenOnPipe(clientsServer, clientsPipeName);
      } catch (error: unknown) {
        this.clientsServer = null;
        this.server?.close();
        this.server = null;
        await removeSessionFile(sessionPath);
        this.ownSession = false;
        throw this.asPipeBusy(clientsPipeName, error);
      }
    }
    this.armOrphanWatchdog();
    this.log("info", "bridge pipe listening", { pipeName });
    return { pipeName, pid: process.pid };
  }

  /** Default: the bridge pipe name with its namespace segment swapped. */
  private clientsPipeName(): string | null {
    if (this.options.clientsPipeName !== undefined) {
      return this.options.clientsPipeName;
    }
    return this.options.pipeName.includes("-bridge-v1-")
      ? this.options.pipeName.replace("-bridge-v1-", "-clients-v1-")
      : `${this.options.pipeName}-clients`;
  }

  private listenOnPipe(server: net.Server, pipeName: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      server.once("error", (error: unknown) => {
        reject(error);
      });
      server.listen(pipeName, () => resolve());
    });
  }

  private asPipeBusy(pipeName: string, error: unknown): unknown {
    if ((error as { code?: unknown }).code === "EADDRINUSE") {
      return new BridgeError(
        "PIPE_BUSY",
        `named pipe ${pipeName} is already owned by another MCP process (is a previous opencode session still running?)`,
        { pipeName },
      );
    }
    return error;
  }

  /**
   * True when the conflicting owner's session is absent, corrupt, or stale
   * (owner PID dead) — safe to drop and retry the listen once. A live
   * owner's session is never touched.
   */
  private async clearStaleSessionFile(sessionPath: string): Promise<boolean> {
    let session: BridgeSession | null = null;
    try {
      session = await loadSessionDescriptor((path) => readFile(path, "utf-8"), sessionPath);
    } catch {
      // Corrupt/unreadable descriptor belongs to nobody real (session writes
      // are atomic): drop it and retry once.
    }
    if (session !== null && !isSessionStale(session, defaultIsPidAlive)) {
      return false;
    }
    try {
      await removeSessionFile(sessionPath);
    } catch {
      return false;
    }
    return true;
  }

  private armOrphanWatchdog(): void {
    const onOrphaned = this.options.onOrphaned;
    if (onOrphaned === undefined) {
      return;
    }
    const parentPid = this.options.parentPid ?? process.ppid ?? 0;
    if (parentPid <= 0) {
      return;
    }
    const intervalMs = this.options.orphanCheckIntervalMs ?? DEFAULT_ORPHAN_CHECK_INTERVAL_MS;
    const isAlive = this.options.isParentAlive ?? defaultIsPidAlive;
    this.orphanTimer = setInterval(() => {
      let alive = false;
      try {
        alive = isAlive(parentPid);
      } catch {
        alive = false;
      }
      if (!alive) {
        // Proxy clients still joined: defer the reap until the last one
        // leaves (they would all lose their owner at once otherwise).
        if (this.clients.size > 0) {
          this.orphanPending = true;
          return;
        }
        this.disarmOrphanWatchdog();
        onOrphaned();
      }
    }, intervalMs);
    this.orphanTimer.unref?.();
  }

  private disarmOrphanWatchdog(): void {
    if (this.orphanTimer !== null) {
      clearInterval(this.orphanTimer);
      this.orphanTimer = null;
    }
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

  /**
   * Proxy-client connection. Decode direction is owner->client: forwarded
   * responses carry screenshots (LARGE). Client->owner frames are requests
   * only (SMALL) — enforced by the handler, never by the decoder here.
   */
  private attachClientSocket(socket: net.Socket): void {
    const decoder = new NativeFrameDecoder("small");
    const client: ClientSocket = { socket, peer: null as unknown as RpcPeer, authed: false };
    const peer = new RpcPeer(
      (message: BridgeMessage) => {
        try {
          socket.write(encodeNativeMessage(message, "large-response"));
        } catch (error: unknown) {
          // Undeliverable (encode bound or dead pipe): drop the client; its
          // pending requests reject through the close handler below.
          this.log("warn", "bridge client send failed", {
            code: error instanceof BridgeError ? error.code : "UNKNOWN",
          });
          socket.destroy();
        }
      },
      {
        handler: (request: BridgeRequest) => this.handleClientRequest(client, request),
        onProtocolError: (error) => {
          // Unknown-id responses are routine here (client-side timeout
          // races a slow forward): log and keep the connection. Structural
          // protocol errors still fail closed.
          if (error.details["id"] === undefined) {
            this.log("warn", "bridge client protocol error", { code: error.code });
            socket.destroy();
          }
        },
      },
    );
    client.peer = peer;
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
      peer.close(new BridgeError("NOT_CONNECTED", "bridge client disconnected"));
      if (this.clients.delete(client)) {
        this.onClientLeft();
      }
    });
    socket.on("error", () => {
      socket.destroy();
    });
    const helloTimeout = this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    setTimeout(() => {
      if (!client.authed) {
        socket.destroy();
      }
    }, helloTimeout).unref?.();
  }

  private onClientLeft(): void {
    if (this.clients.size > 0) {
      return;
    }
    if (this.orphanPending) {
      this.orphanPending = false;
      this.disarmOrphanWatchdog();
      this.options.onOrphaned?.();
      return;
    }
    this.options.onClientsIdle?.();
  }

  private async handleClientRequest(client: ClientSocket, request: BridgeRequest): Promise<unknown> {
    if (request.method === "bridge.hello") {
      const nonce = request.payload["nonce"];
      const version = request.payload["bridgeVersion"];
      if (typeof nonce !== "string" || !safeEqualString(nonce, this.currentNonce())) {
        setImmediate(() => client.socket.destroy());
        throw new BridgeError("NOT_AUTHENTICATED", "bridge client hello presented an invalid session nonce");
      }
      if (version !== BRIDGE_PROTOCOL_VERSION) {
        setImmediate(() => client.socket.destroy());
        throw new BridgeError(
          "UNSUPPORTED_VERSION",
          `bridge client hello version ${JSON.stringify(version)} is not supported`,
        );
      }
      if (!client.authed) {
        client.authed = true;
        this.clients.add(client);
      }
      this.log("info", "bridge proxy client authenticated", { clientCount: this.clients.size });
      return {
        ok: true,
        bridgeVersion: BRIDGE_PROTOCOL_VERSION,
        mcpPid: process.pid,
        relayConnected: this.state === "connected",
      };
    }
    if (!client.authed) {
      setImmediate(() => client.socket.destroy());
      throw new BridgeError("NOT_AUTHENTICATED", "bridge client request before authenticated hello");
    }
    const relayPeer = this.relay?.peer;
    if (relayPeer === undefined) {
      throw new BridgeError("NOT_CONNECTED", "no authenticated bridge relay is connected");
    }
    // Forward verbatim: the extension answers the same typed bridge methods
    // it serves the owner. Correlation is end-to-end by request id.
    const result = await relayPeer.requestDetailed(request.method, request.payload, CLIENT_FORWARD_TIMEOUT_MS);
    return result.payload;
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
    this.disarmOrphanWatchdog();
    this.orphanPending = false;
    this.setState("closed");
    const relay = this.relay;
    this.relay = null;
    relay?.peer.close(new BridgeError("NOT_CONNECTED", "bridge server stopping"));
    relay?.socket.destroy();
    for (const client of [...this.clients]) {
      client.peer.close(new BridgeError("NOT_CONNECTED", "bridge server stopping"));
      client.socket.destroy();
    }
    this.clients.clear();
    const clientsServer = this.clientsServer;
    this.clientsServer = null;
    if (clientsServer !== null) {
      await new Promise<void>((resolve) => {
        clientsServer.close(() => resolve());
      });
    }
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
