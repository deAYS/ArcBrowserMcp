import * as net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import { McpPipeServer } from "../src/bridge/mcpPipeServer.js";
import { encodeNativeMessage, NativeFrameDecoder } from "../src/bridge/nativeFraming.js";
import { parseSessionDescriptor } from "../src/bridge/session.js";

const PIPE_PREFIX = "\\\\.\\pipe\\arc-mcp-test-";

let pipeSerial = 0;
function freshPipeName(): string {
  pipeSerial += 1;
  return `${PIPE_PREFIX}${String(process.pid)}-${String(pipeSerial)}`;
}

async function tempSessionDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-pipe-test-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Raw framed client that speaks the pipe protocol without the server class. */
function rawHello(pipeName: string, payload: Record<string, unknown>): Promise<{ frames: unknown[]; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = net.createConnection(pipeName);
    const decoder = new NativeFrameDecoder();
    const frames: unknown[] = [];
    let closed = false;
    const done = (): void => resolve({ frames, closed });
    socket.on("connect", () => {
      socket.write(encodeNativeMessage({ version: 1, id: "raw-1", type: "request", method: "bridge.hello", payload }));
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
}

describe("MCP pipe authentication", () => {
  it("writes a valid session descriptor on start and removes it on stop", async () => {
    const { dir, cleanup } = await tempSessionDir();
    try {
      const server = new McpPipeServer({ pipeName: freshPipeName(), sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      await server.start();
      const session = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));
      expect(session.mcpPid).toBe(process.pid);
      expect(session.nonceHex).toMatch(/^[0-9a-f]{64}$/);
      await server.stop();
      await expect(readFile(path.join(dir, "bridge-session.json"), "utf-8")).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("rejects requests before hello and closes the socket", async () => {
    const { dir, cleanup } = await tempSessionDir();
    try {
      const pipeName = freshPipeName();
      const server = new McpPipeServer({ pipeName, sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      await server.start();
      const outcome = await rawHello(pipeName, { method: "wrong-shape" });
      // Sent a hello-shaped frame with a bad nonce: NOT_AUTHENTICATED + close.
      expect(outcome.frames).toHaveLength(1);
      expect(outcome.frames[0]).toMatchObject({ type: "response", ok: false });
      expect(outcome.closed).toBe(true);
      await server.stop();
    } finally {
      await cleanup();
    }
  });

  it("rejects unauthenticated non-hello requests", async () => {
    const { dir, cleanup } = await tempSessionDir();
    try {
      const pipeName = freshPipeName();
      const server = new McpPipeServer({ pipeName, sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      await server.start();
      const outcome = await new Promise<{ frames: unknown[]; closed: boolean }>((resolve) => {
        const socket = net.createConnection(pipeName);
        const decoder = new NativeFrameDecoder();
        const frames: unknown[] = [];
        let closed = false;
        const done = (): void => resolve({ frames, closed });
        socket.on("connect", () => {
          socket.write(
            encodeNativeMessage({ version: 1, id: "raw-2", type: "request", method: "bridge.ping", payload: {} }),
          );
        });
        socket.on("data", (chunk: Buffer) => {
          frames.push(...decoder.push(chunk));
        });
        socket.on("close", () => {
          closed = true;
          done();
        });
        socket.on("error", () => done());
        setTimeout(done, 3_000).unref?.();
      });
      expect(outcome.frames).toHaveLength(1);
      expect(outcome.frames[0]).toMatchObject({ type: "response", ok: false });
      expect(outcome.closed).toBe(true);
      await server.stop();
    } finally {
      await cleanup();
    }
  });

  it("refuses server requests with no relay connected", async () => {
    const { dir, cleanup } = await tempSessionDir();
    try {
      const server = new McpPipeServer({ pipeName: freshPipeName(), sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      await server.start();
      let caught: unknown = null;
      try {
        await server.request("bridge.ping", {}, 500);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BridgeError);
      expect((caught as BridgeError).code).toBe("NOT_CONNECTED");
      await server.stop();
    } finally {
      await cleanup();
    }
  });

  it("rejects a second active owner of the same pipe", async () => {
    const { dir, cleanup } = await tempSessionDir();
    try {
      const pipeName = freshPipeName();
      const first = new McpPipeServer({ pipeName, sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      await first.start();
      const second = new McpPipeServer({ pipeName, sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      let caught: unknown = null;
      try {
        await second.start();
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BridgeError);
      expect((caught as BridgeError).code).toBe("PIPE_BUSY");
      await first.stop();
    } finally {
      await cleanup();
    }
  });
});

describe("MCP pipe relay round-trip", () => {
  it("authenticates a relay and routes a correlated request", async () => {
    const { dir, cleanup } = await tempSessionDir();
    try {
      const pipeName = freshPipeName();
      const server = new McpPipeServer({ pipeName, sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      await server.start();
      const session = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));

      // Minimal in-test relay: hello, then answer pongs.
      const socket = net.createConnection(pipeName);
      const decoder = new NativeFrameDecoder();
      const write = (value: unknown): void => {
        socket.write(encodeNativeMessage(value));
      };
      await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => {
          write({ version: 1, id: "h1", type: "request", method: "bridge.hello", payload: { nonce: session.nonceHex, bridgeVersion: 1 } });
        });
        const onData = (chunk: Buffer): void => {
          for (const frame of decoder.push(chunk)) {
            const message = frame as { type?: unknown; id?: unknown; ok?: unknown };
            if (message.type === "response" && message.id === "h1" && message.ok === true) {
              socket.off("data", onData);
              resolve();
              return;
            }
          }
        };
        socket.on("data", onData);
        socket.on("error", reject);
        setTimeout(() => reject(new Error("hello round-trip timed out")), 5_000).unref?.();
      });
      expect(server.relayState).toBe("connected");

      // MCP -> relay request; relay answers with the same correlation id.
      const pending = server.request("bridge.ping", { marker: 7 }, 5_000);
      const asked = await new Promise<{ id: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no ping arrived at relay")), 5_000);
        const onData = (chunk: Buffer): void => {
          for (const frame of decoder.push(chunk)) {
            const message = frame as { type?: unknown; id?: unknown; method?: unknown };
            if (message.type === "request" && typeof message.id === "string") {
              clearTimeout(timer);
              socket.off("data", onData);
              resolve({ id: message.id });
              return;
            }
          }
        };
        socket.on("data", onData);
      });
      write({ version: 1, id: asked.id, type: "response", ok: true, payload: { pong: true, marker: 7 } });
      await expect(pending).resolves.toEqual({ pong: true, marker: 7 });

      socket.destroy();
      await server.stop();
    } finally {
      await cleanup();
    }
  });
});

