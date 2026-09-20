import { EventEmitter } from "node:events";
import type * as net from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { fileSessionLoader, runHost } from "../src/bridge/native-host/host.js";
import type { HostRunOptions } from "../src/bridge/native-host/host.js";
import { encodeNativeMessage, NativeFrameDecoder } from "../src/bridge/nativeFraming.js";
import type { BridgeSession } from "../src/bridge/session.js";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const SESSION: BridgeSession = {
  version: 1,
  pipeName: "\\\\.\\pipe\\test",
  nonceHex: "a".repeat(64),
  mcpPid: 4242,
  createdAt: new Date().toISOString(),
};

class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  destroyed = false;

  write(chunk: Buffer): boolean {
    this.written.push(Buffer.from(chunk));
    return true;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }

  framesWritten(): unknown[] {
    const decoder = new NativeFrameDecoder();
    const out: unknown[] = [];
    for (const chunk of this.written) {
      out.push(...decoder.push(chunk));
    }
    return out;
  }

  deliver(frame: unknown): void {
    this.emit("data", encodeNativeMessage(frame));
  }
}

interface Harness {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly logs: string[];
  readonly sockets: FakeSocket[];
  stdoutFrames(): unknown[];
  base: Omit<HostRunOptions, "argv">;
}

function harness(overrides: {
  session?: BridgeSession | null;
  onSocket?: (socket: FakeSocket) => void;
  isPidAlive?: (pid: number) => boolean;
} = {}): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const decoder = new NativeFrameDecoder();
  const collected: unknown[] = [];
  stdout.on("data", (chunk: Buffer) => {
    collected.push(...decoder.push(chunk));
  });
  const logs: string[] = [];
  const sockets: FakeSocket[] = [];
  const session = overrides.session === undefined ? SESSION : overrides.session;
  const harnessValue: Harness = {
    stdin,
    stdout,
    logs,
    sockets,
    stdoutFrames: () => collected,
    base: {
      expectedOrigin: ORIGIN,
      loadSession: () => Promise.resolve(session),
      stdin,
      stdout,
      log: (message: string) => {
        logs.push(message);
      },
      connectPipe: (pipeName: string) => {
        expect(pipeName).toBe(SESSION.pipeName);
        const socket = new FakeSocket();
        sockets.push(socket);
        overrides.onSocket?.(socket);
        return Promise.resolve(socket as unknown as net.Socket);
      },
      helloTimeoutMs: 2_000,
      isPidAlive: overrides.isPidAlive ?? (() => true),
    },
  };
  return harnessValue;
}

function run(argv: string[], h: Harness): Promise<number> {
  return runHost({ ...h.base, argv });
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("native host gating", () => {
  it("refuses a wrong origin without touching the pipe (exit 1)", async () => {
    const h = harness();
    const code = await run(["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/", "--parent-window=1"], h);
    expect(code).toBe(1);
    expect(h.sockets).toHaveLength(0);
    expect(h.logs.join(" ")).toContain("refusing caller");
  });

  it("exits 2 when no session exists", async () => {
    const h = harness({ session: null });
    const code = await run([ORIGIN], h);
    expect(code).toBe(2);
    expect(h.sockets).toHaveLength(0);
  });

  it("exits 3 on a stale session", async () => {
    const h = harness({ isPidAlive: () => false });
    const code = await run([ORIGIN], h);
    expect(code).toBe(3);
    expect(h.sockets).toHaveLength(0);
  });

  it("exits 5 when the pipe rejects the hello nonce", async () => {
    const h = harness({
      onSocket: (socket) => {
        socket.deliver({ version: 1, id: "host-hello", type: "response", ok: false, error: { code: "X", message: "no" } });
      },
    });
    const code = await run([ORIGIN], h);
    expect(code).toBe(5);
    expect(h.sockets[0]?.destroyed).toBe(true);
  });
});

describe("native host relay", () => {
  it("authenticates, forwards both directions, and exits cleanly on EOF", async () => {
    const h = harness({
      onSocket: (socket) => {
        // Answer the hello as soon as it arrives.
        const check = (): void => {
          for (const frame of socket.framesWritten()) {
            const message = frame as { id?: unknown };
            if (message.id === "host-hello") {
              socket.deliver({ version: 1, id: "host-hello", type: "response", ok: true, payload: { ok: true } });
              return;
            }
          }
          setImmediate(check);
        };
        check();
      },
    });
    const completed = run([ORIGIN, "--parent-window=7"], h);
    await waitFor(() => h.sockets.length === 1, "pipe connect");

    // Extension -> MCP: ping request forwarded to the pipe with the same id.
    h.stdin.write(encodeNativeMessage({ version: 1, id: "ping-1", type: "request", method: "bridge.ping", payload: {} }));
    await waitFor(
      () => h.sockets[0]?.framesWritten().some((frame) => (frame as { id?: unknown }).id === "ping-1") ?? false,
      "ping forwarded to pipe",
    );

    // MCP -> extension: pong forwarded to native stdout with the same id.
    h.sockets[0]?.deliver({ version: 1, id: "ping-1", type: "response", ok: true, payload: { pong: true } });
    await waitFor(
      () => h.stdoutFrames().some((frame) => (frame as { id?: unknown }).id === "ping-1"),
      "pong forwarded to native",
    );
    const pong = h.stdoutFrames().find((frame) => (frame as { id?: unknown }).id === "ping-1") as {
      ok?: unknown;
      payload?: unknown;
    };
    expect(pong.ok).toBe(true);
    expect(pong.payload).toEqual({ pong: true });

    h.stdin.end();
    await expect(completed).resolves.toBe(0);
  });

  it("exits 6 on a malformed native frame", async () => {
    const h = harness({
      onSocket: (socket) => {
        // Answer the hello once the host actually sends it.
        const check = (): void => {
          const seenHello = socket.framesWritten().some(
            (frame) => (frame as { id?: unknown }).id === "host-hello",
          );
          if (seenHello) {
            socket.deliver({ version: 1, id: "host-hello", type: "response", ok: true, payload: {} });
            return;
          }
          setImmediate(check);
        };
        check();
      },
    });
    const completed = run([ORIGIN], h);
    await waitFor(() => h.sockets.length === 1, "pipe connect");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(5, 0);
    h.stdin.write(Buffer.concat([header, Buffer.from("{oops", "utf-8")]));
    await expect(completed).resolves.toBe(6);
  });
});

describe("fileSessionLoader", () => {
  it("returns null for a missing file and rejects corrupt content", async () => {
    const missing = fileSessionLoader("C:\\definitely\\not\\here\\bridge-session.json");
    await expect(missing()).resolves.toBeNull();
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { default: path } = await import("node:path");
    const { default: os } = await import("node:os");
    const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-loader-"));
    try {
      const file = path.join(dir, "bridge-session.json");
      await writeFile(file, "{oops", "utf-8");
      await expect(fileSessionLoader(file)()).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
