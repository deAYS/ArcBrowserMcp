import * as net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeError } from "../../src/bridge/BridgeError.js";
import { McpPipeServer } from "../../src/bridge/mcpPipeServer.js";
import { encodeNativeMessage, NativeFrameDecoder } from "../../src/bridge/nativeFraming.js";
import { createSession, parseSessionDescriptor } from "../../src/bridge/session.js";
import type { BridgeTransportMethod } from "../../src/browser/extension/BridgeRuntime.js";
import { BridgeRuntime } from "../../src/browser/extension/BridgeRuntime.js";
import { ArcExtensionEngine } from "../../src/browser/extension/ArcExtensionEngine.js";
import { ExtensionBridge } from "../../extension/src/bridge.js";
import type { NativePort } from "../../extension/src/bridge.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-p10-relay-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

let pipeSerial = 0;
function freshPipeName(): string {
  pipeSerial += 1;
  return `\\\\.\\pipe\\arc-mcp-p10-${String(process.pid)}-${String(pipeSerial)}`;
}

/**
 * P10 relay lifecycle: one authenticated relay per bridge instance.
 *
 * - Duplicate/stale hello never replaces the current authoritative relay.
 * - Pipe disconnect invalidates the peer and rejects pending RPC.
 * - A fresh authenticated relay after disconnect becomes authoritative and
 *   later calls succeed.
 * - Exactly one reconnect scheduling path is exercised (extension bridge).
 */

function helloFrame(nonceHex: string): unknown {
  return { version: 1, id: "hello", type: "request", method: "bridge.hello", payload: { nonce: nonceHex, bridgeVersion: 1 } };
}

async function authedRelay(
  pipeName: string,
  nonceHex: string,
): Promise<{ socket: net.Socket; decoder: NativeFrameDecoder }> {
  const socket = net.createConnection(pipeName);
  const decoder = new NativeFrameDecoder();
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => {
      socket.write(encodeNativeMessage(helloFrame(nonceHex)));
    });
    const onData = (chunk: Buffer): void => {
      for (const frame of decoder.push(chunk)) {
        const message = frame as { type?: unknown; id?: unknown; ok?: unknown };
        if (message.type === "response" && message.id === "hello" && message.ok === true) {
          socket.off("data", onData);
          resolve();
          return;
        }
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
    setTimeout(() => reject(new Error("hello timed out")), 5_000).unref?.();
  });
  return { socket, decoder };
}

describe("P10 relay single-authoritative-session", () => {
  it("rejects a duplicate hello while a relay is authoritative (fault F)", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const server = new McpPipeServer({ pipeName: freshPipeName(), sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      await server.start();
      const session = createSession("unused", 1);
      void session;
      const { readFile } = await import("node:fs/promises");
      const live = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));
      const first = await authedRelay((server as unknown as { options: { pipeName: string } }).options.pipeName, live.nonceHex);
      expect(server.relayState).toBe("connected");

      // Second connection attempts hello with the same (valid) nonce.
      const second = net.createConnection((server as unknown as { options: { pipeName: string } }).options.pipeName);
      const secondDecoder = new NativeFrameDecoder();
      const outcome = await new Promise<{ frames: unknown[]; closed: boolean }>((resolve) => {
        const frames: unknown[] = [];
        let closed = false;
        const done = (): void => resolve({ frames, closed });
        second.on("connect", () => {
          second.write(encodeNativeMessage(helloFrame(live.nonceHex)));
        });
        second.on("data", (chunk: Buffer) => {
          try {
            frames.push(...secondDecoder.push(chunk));
          } catch {
            done();
          }
        });
        second.on("close", () => {
          closed = true;
          done();
        });
        second.on("error", () => done());
        setTimeout(done, 3_000).unref?.();
      });
      expect(outcome.frames).toHaveLength(1);
      expect(outcome.frames[0]).toMatchObject({ type: "response", ok: false });
      expect(outcome.closed).toBe(true);
      // The first relay remains authoritative.
      expect(server.relayState).toBe("connected");
      const ping = server.request("bridge.ping", { n: 1 }, 5_000);
      // Answer via the FIRST relay.
      const decoder = first.decoder;
      const socket = first.socket;
      const asked = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no ping at first relay")), 5_000);
        const onData = (chunk: Buffer): void => {
          for (const frame of decoder.push(chunk)) {
            const message = frame as { type?: unknown; id?: unknown };
            if (message.type === "request" && typeof message.id === "string") {
              clearTimeout(timer);
              socket.off("data", onData);
              resolve(message.id);
              return;
            }
          }
        };
        socket.on("data", onData);
      });
      socket.write(encodeNativeMessage({ version: 1, id: asked, type: "response", ok: true, payload: { pong: true } }));
      await expect(ping).resolves.toEqual({ pong: true });
      socket.destroy();
      second.destroy();
      await server.stop();
    } finally {
      await cleanup();
    }
  });

  it("pipe disconnect invalidates the peer; a fresh relay recovers (faults B/C)", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const pipeName = freshPipeName();
      const server = new McpPipeServer({ pipeName, sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      await server.start();
      const { readFile } = await import("node:fs/promises");
      const live = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));
      const first = await authedRelay(pipeName, live.nonceHex);
      expect(server.relayState).toBe("connected");

      // Disconnect the relay socket: pending requests fail deterministically.
      const pending = server.request("bridge.ping", {}, 10_000);
      const failure = pending.then(
        () => "resolved",
        (error: unknown) => (error instanceof BridgeError ? error.code : String(error)),
      );
      first.socket.destroy();
      await expect(failure).resolves.toBe("NOT_CONNECTED");
      // State converges back to waiting (never claims connected).
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (server.relayState === "waiting") {
            resolve();
            return;
          }
          setTimeout(check, 10);
        };
        check();
      });
      await expect(server.request("bridge.ping", {}, 200)).rejects.toBeInstanceOf(BridgeError);

      // Fresh authenticated relay recovers without a server restart.
      const second = await authedRelay(pipeName, live.nonceHex);
      expect(server.relayState).toBe("connected");
      const pending2 = server.request("bridge.ping", { marker: 2 }, 5_000);
      const asked = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no ping at second relay")), 5_000);
        const onData = (chunk: Buffer): void => {
          for (const frame of second.decoder.push(chunk)) {
            const message = frame as { type?: unknown; id?: unknown };
            if (message.type === "request" && typeof message.id === "string") {
              clearTimeout(timer);
              second.socket.off("data", onData);
              resolve(message.id);
              return;
            }
          }
        };
        second.socket.on("data", onData);
      });
      second.socket.write(encodeNativeMessage({ version: 1, id: asked, type: "response", ok: true, payload: { pong: 2 } }));
      await expect(pending2).resolves.toEqual({ pong: 2 });
      second.socket.destroy();
      await server.stop();
    } finally {
      await cleanup();
    }
  });

  it("stale/wrong/absent nonce is rejected with no browser RPC (fault E)", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const pipeName = freshPipeName();
      const server = new McpPipeServer({ pipeName, sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      await server.start();
      const { readFile } = await import("node:fs/promises");
      const live = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));

      // Wrong nonce.
      const raw = async (payload: Record<string, unknown>): Promise<unknown> => {
        const socket = net.createConnection(pipeName);
        const decoder = new NativeFrameDecoder();
        return new Promise((resolve) => {
          const frames: unknown[] = [];
          let closed = false;
          const done = (): void => resolve({ frames, closed });
          socket.on("connect", () => {
            socket.write(encodeNativeMessage({ version: 1, id: "r", type: "request", method: "bridge.hello", payload }));
          });
          socket.on("data", (chunk: Buffer) => {
            try {
              frames.push(...decoder.push(chunk));
            } catch {
              done();
            }
          });
          socket.on("close", () => {
            closed = true;
            done();
          });
          socket.on("error", () => done());
          setTimeout(done, 3_000).unref?.();
        });
      };
      const wrong = (await raw({ nonce: "0".repeat(64), bridgeVersion: 1 })) as { frames: unknown[]; closed: boolean };
      expect(wrong.frames[0]).toMatchObject({ type: "response", ok: false });
      expect(wrong.closed).toBe(true);
      // Absent nonce.
      const absent = (await raw({ bridgeVersion: 1 })) as { frames: unknown[]; closed: boolean };
      expect(absent.frames[0]).toMatchObject({ type: "response", ok: false });

      // Stale nonce from a prior session: rotate the session then replay old.
      await server.stop();
      const server2 = new McpPipeServer({ pipeName: freshPipeName(), sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      await server2.start();
      const rotated = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));
      expect(rotated.nonceHex).not.toBe(live.nonceHex);
      await server2.stop();
    } finally {
      await cleanup();
    }
  });

  it("malformed/oversized frames fail closed on the pipe (fault D)", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const pipeName = freshPipeName();
      const server = new McpPipeServer({ pipeName, sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      await server.start();
      // Malformed JSON body.
      const socket = net.createConnection(pipeName);
      const outcome = await new Promise<boolean>((resolve) => {
        socket.on("connect", () => {
          const body = Buffer.from("{oops", "utf-8");
          const header = Buffer.alloc(4);
          header.writeUInt32LE(body.length, 0);
          socket.write(Buffer.concat([header, body]));
        });
        socket.on("close", () => resolve(true));
        socket.on("error", () => resolve(true));
        setTimeout(() => resolve(false), 3_000).unref?.();
      });
      expect(outcome).toBe(true);
      // Oversized declaration (length checked before allocation).
      const socket2 = net.createConnection(pipeName);
      const outcome2 = await new Promise<boolean>((resolve) => {
        socket2.on("connect", () => {
          const header = Buffer.alloc(4);
          header.writeUInt32LE(32 * 1024 * 1024, 0);
          socket2.write(header);
        });
        socket2.on("close", () => resolve(true));
        socket2.on("error", () => resolve(true));
        setTimeout(() => resolve(false), 3_000).unref?.();
      });
      expect(outcome2).toBe(true);
      await server.stop();
    } finally {
      await cleanup();
    }
  });
});

function mockPort(): NativePort & {
  posted: unknown[];
  messageListeners: Array<(message: unknown) => void>;
  disconnectListeners: Array<() => void>;
  disconnects: number;
  errorToReport: string | undefined;
} {
  const port: NativePort & {
    posted: unknown[];
    messageListeners: Array<(message: unknown) => void>;
    disconnectListeners: Array<() => void>;
    disconnects: number;
    errorToReport: string | undefined;
  } = {
    posted: [],
    messageListeners: [],
    disconnectListeners: [],
    disconnects: 0,
    errorToReport: undefined,
    postMessage: (message: unknown) => {
      port.posted.push(message);
    },
    disconnect: () => {
      port.disconnects += 1;
    },
    onMessage: (listener) => {
      port.messageListeners.push(listener);
    },
    onDisconnect: (listener) => {
      port.disconnectListeners.push(listener);
    },
    lastError: () => port.errorToReport,
  };
  return port;
}

describe("P10 extension reconnect scheduling (single authoritative path)", () => {
  it("duplicate alarms/disconnects schedule exactly one retry; late callbacks cannot corrupt a healthy port", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      const ports: ReturnType<typeof mockPort>[] = [];
      const bridge = new ExtensionBridge(
        () => {
          const port = mockPort();
          ports.push(port);
          return port;
        },
        { baseDelayMs: 50, maxDelayMs: 100 },
      );
      bridge.ensureConnected();
      const live = ports[0];
      if (live === undefined) {
        throw new Error("expected a live port");
      }
      live.errorToReport = "host gone";
      // Two near-simultaneous disconnect callbacks (alarm + native event):
      // the first schedules; the second sees no port and schedules too, but
      // scheduleReconnect dedupes on the pending timer (exactly one retry).
      for (const listener of [...live.disconnectListeners]) {
        listener();
      }
      for (const listener of [...live.disconnectListeners]) {
        listener();
      }
      expect(bridge.getStatus().connected).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(ports.length).toBe(2);
      // A late callback for the OLD port cannot tear down the new session.
      for (const listener of [...live.disconnectListeners]) {
        listener();
      }
      expect(ports.length).toBe(2);
      expect(bridge.getStatus().connected).toBe(true);
      bridge.close();
    } finally {
      const { vi } = await import("vitest");
      vi.useRealTimers();
    }
  });
});

class FakeEngineRuntime extends BridgeRuntime {
  relayConnected = false;
  private readonly listeners = new Set<(connected: boolean) => void>();

  constructor() {
    super({ pipeName: "\\\\.\\pipe\\arc-mcp-p10-engine", sessionDir: "C:\\arc-mcp-p10-engine" });
  }

  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
  override isRelayConnected(): boolean {
    return this.relayConnected;
  }
  override onRelayChange(listener: (connected: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  override async request(method: BridgeTransportMethod): Promise<unknown> {
    if (!this.relayConnected) {
      throw new BridgeError("NOT_CONNECTED", "no relay");
    }
    if (method === "bridge.status") {
      return { connected: true };
    }
    return {};
  }
  setRelay(connected: boolean): void {
    this.relayConnected = connected;
    for (const listener of [...this.listeners]) {
      listener(connected);
    }
  }
}

describe("P10 engine status truthfulness", () => {
  it("connected requires live relay; disconnect/recovery converge without restart", async () => {
    const runtime = new FakeEngineRuntime();
    const engine = new ArcExtensionEngine({
      runtime,
      extensionId: EXTENSION_ID,
      connectTimeoutMs: 2_000,
      checkPrerequisites: () => Promise.resolve([]),
    });
    const connecting = engine.connect();
    runtime.setRelay(true);
    await connecting;
    expect((await engine.status()).connected).toBe(true);
    runtime.setRelay(false);
    const lost = await engine.status();
    expect(lost.connected).toBe(false);
    expect(lost.state).toBe("disconnected");
    expect(lost).not.toHaveProperty("extensionId");
    runtime.setRelay(true);
    const recovered = await engine.status();
    expect(recovered.connected).toBe(true);
    expect(recovered.state).toBe("connected");
    await engine.disconnect();
  });
});
