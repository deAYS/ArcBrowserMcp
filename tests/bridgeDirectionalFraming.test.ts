import { EventEmitter } from "node:events";
import * as net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import { McpPipeServer } from "../src/bridge/mcpPipeServer.js";
import { encodeNativeMessage, NativeFrameDecoder } from "../src/bridge/nativeFraming.js";
import { runHost } from "../src/bridge/native-host/host.js";
import type { HostRunOptions } from "../src/bridge/native-host/host.js";
import {
  LARGE_RESPONSE_FRAME_MAX_BYTES,
  SCREENSHOT_MAX_DECODED_BYTES,
  SMALL_FRAME_MAX_BYTES,
} from "../src/bridge/frameLimits.js";
import { parseSessionDescriptor } from "../src/bridge/session.js";
import type { BridgeSession } from "../src/bridge/session.js";

/**
 * Directional transport capacity (mocked/static).
 *
 * The bridge codec carries two payload classes over one length-prefixed
 * framing: SMALL (256 KiB) for every request/command path and all
 * host->extension traffic, LARGE (16 MiB) for extension-originated
 * responses only (the screenshot direction). These tests prove the
 * direction roles enforce the right bound at every layer without chunking,
 * streaming, or touching the extension.
 */

const SMALL = SMALL_FRAME_MAX_BYTES; // 262144
const LARGE = LARGE_RESPONSE_FRAME_MAX_BYTES; // 16777216

/** Payload whose JSON body is exactly `bytes` long: {"data":"<pad>"} is 11 bytes of fixed JSON. */
function exactBodyPayload(bytes: number): { data: string } {
  return { data: "x".repeat(bytes - 11) };
}

function headerOnly(declaredLength: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(declaredLength, 0);
  return header;
}

describe("capacity model constants", () => {
  it("declares the approved directional bounds", () => {
    expect(SMALL).toBe(256 * 1024);
    expect(LARGE).toBe(16 * 1024 * 1024);
    // Screenshot capability bound fits inside the large frame with base64
    // margin: 8 MiB decoded -> ~10.67 MiB base64 + envelope < 16 MiB.
    expect(SCREENSHOT_MAX_DECODED_BYTES).toBe(8 * 1024 * 1024);
    const wire = Math.ceil(SCREENSHOT_MAX_DECODED_BYTES / 3) * 4;
    expect(wire).toBeLessThan(LARGE);
  });

  it("keeps the legacy alias pinned to the small bound", async () => {
    const protocol = await import("../src/bridge/protocol.js");
    expect(protocol.MAX_BRIDGE_MESSAGE_BYTES).toBe(SMALL);
  });
});

describe("small direction (requests, host->extension)", () => {
  it("round-trips a normal small frame with the default role", () => {
    const encoded = encodeNativeMessage({ type: "request", id: "s-1" });
    expect(new NativeFrameDecoder().push(encoded)).toEqual([{ type: "request", id: "s-1" }]);
    expect(new NativeFrameDecoder("small").push(encodeNativeMessage({ n: 1 }, "small"))).toEqual([{ n: 1 }]);
  });

  it("accepts a body of exactly 256 KiB and rejects 256 KiB + 1", () => {
    const exact = encodeNativeMessage(exactBodyPayload(SMALL));
    expect(exact.readUInt32LE(0)).toBe(SMALL);
    expect(new NativeFrameDecoder().push(exact)).toEqual([exactBodyPayload(SMALL)]);
    expect(() => encodeNativeMessage(exactBodyPayload(SMALL + 1))).toThrow(BridgeError);
    let caught: unknown = null;
    try {
      // Header-only: rejected before any body allocation or read.
      new NativeFrameDecoder().push(headerOnly(SMALL + 1));
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe("NATIVE_FRAME_TOO_LARGE");
  });

  it("does NOT apply the large-response allowance to the small role", () => {
    const payload = { blob: "y".repeat(300 * 1024) };
    expect(() => encodeNativeMessage(payload)).toThrow(BridgeError);
    expect(() => encodeNativeMessage(payload, "small")).toThrow(BridgeError);
    // But the identical bytes are legal once explicitly marked large-response.
    const encoded = encodeNativeMessage(payload, "large-response");
    expect(new NativeFrameDecoder("large-response").push(encoded)).toEqual([payload]);
    // And a small decoder still rejects that declared length on sight.
    let caught: unknown = null;
    try {
      new NativeFrameDecoder().push(headerOnly(encoded.readUInt32LE(0)));
    } catch (error: unknown) {
      caught = error;
    }
    expect((caught as BridgeError).code).toBe("NATIVE_FRAME_TOO_LARGE");
  });

  it("rejects zero and absurd length prefixes without reading a body", () => {
    for (const declared of [0, 0xffffffff, 64 * 1024 * 1024]) {
      const decoder = new NativeFrameDecoder();
      let caught: unknown = null;
      try {
        decoder.push(headerOnly(declared));
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BridgeError);
      expect((caught as BridgeError).code).toBe("NATIVE_FRAME_TOO_LARGE");
      // Decoder reset: the stream is usable after the rejection.
      expect(decoder.push(encodeNativeMessage({ ok: true }))).toEqual([{ ok: true }]);
    }
  });
});

describe("large response direction (extension-originated only)", () => {
  it("carries a 256 KiB+ response and a representative ~2 MiB response", () => {
    for (const bytes of [300 * 1024, 2 * 1024 * 1024]) {
      const payload = { id: "r", blob: "z".repeat(bytes) };
      const encoded = encodeNativeMessage(payload, "large-response");
      expect(encoded.readUInt32LE(0)).toBeGreaterThan(SMALL);
      expect(new NativeFrameDecoder("large-response").push(encoded)).toEqual([payload]);
    }
  });

  it("carries a representative ~12 MiB encoded response", () => {
    const payload = exactBodyPayload(12 * 1024 * 1024);
    const encoded = encodeNativeMessage(payload, "large-response");
    expect(encoded.length).toBeGreaterThan(12 * 1024 * 1024);
    expect(encoded.length).toBeLessThan(LARGE);
    expect(new NativeFrameDecoder("large-response").push(encoded)).toEqual([payload]);
  });

  it("accepts exactly 16 MiB and rejects 16 MiB + 1 before allocation", () => {
    const exact = encodeNativeMessage(exactBodyPayload(LARGE), "large-response");
    expect(exact.readUInt32LE(0)).toBe(LARGE);
    expect(new NativeFrameDecoder("large-response").push(exact)).toEqual([exactBodyPayload(LARGE)]);
    expect(() => encodeNativeMessage(exactBodyPayload(LARGE + 1), "large-response")).toThrow(BridgeError);
    // Decode-side: a 4-byte header declaring LARGE+1 throws with no body.
    const decoder = new NativeFrameDecoder("large-response");
    let caught: unknown = null;
    try {
      decoder.push(headerOnly(LARGE + 1));
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe("NATIVE_FRAME_TOO_LARGE");
    expect(decoder.push(encodeNativeMessage({ ok: true }, "large-response"))).toEqual([{ ok: true }]);
  });

  it("handles an incomplete large frame safely at EOF", () => {
    const full = encodeNativeMessage({ blob: "q".repeat(1024) }, "large-response");
    const decoder = new NativeFrameDecoder("large-response");
    expect(decoder.push(full.subarray(0, full.length - 16))).toEqual([]);
    let caught: unknown = null;
    try {
      decoder.end();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe("NATIVE_FRAME_INCOMPLETE");
  });
});

// ---------------------------------------------------------------------------
// Native-host relay direction tests (no browser, no extension).
// ---------------------------------------------------------------------------

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const SESSION: BridgeSession = {
  version: 1,
  pipeName: "\\\\.\\pipe\\directional-test",
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
    const decoder = new NativeFrameDecoder("large-response");
    const out: unknown[] = [];
    for (const chunk of this.written) {
      out.push(...decoder.push(chunk));
    }
    return out;
  }

  deliver(frame: unknown, direction: "small" | "large-response" = "small"): void {
    this.emit("data", encodeNativeMessage(frame, direction));
  }
}

function hostHarness(overrides: { onSocket?: (socket: FakeSocket) => void } = {}): {
  stdin: PassThrough;
  stdout: PassThrough;
  logs: string[];
  sockets: FakeSocket[];
  base: Omit<HostRunOptions, "argv">;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const logs: string[] = [];
  const sockets: FakeSocket[] = [];
  return {
    stdin,
    stdout,
    logs,
    sockets,
    base: {
      expectedOrigin: ORIGIN,
      loadSession: () => Promise.resolve(SESSION),
      stdin,
      stdout,
      log: (message: string) => {
        logs.push(message);
      },
      connectPipe: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        overrides.onSocket?.(socket);
        return Promise.resolve(socket as unknown as net.Socket);
      },
      helloTimeoutMs: 2_000,
      isPidAlive: () => true,
    },
  };
}

function answerHello(socket: FakeSocket): void {
  const check = (): void => {
    const seen = socket.framesWritten().some((frame) => (frame as { id?: unknown }).id === "host-hello");
    if (seen) {
      socket.deliver({ version: 1, id: "host-hello", type: "response", ok: true, payload: {} });
      return;
    }
    setImmediate(check);
  };
  check();
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe("native-host relay directions", () => {
  it("forwards a >256 KiB extension response to the pipe and stays alive", async () => {
    const h = hostHarness({ onSocket: (socket) => answerHello(socket) });
    const completed = runHost({ ...h.base, argv: [ORIGIN] });
    await waitFor(() => h.sockets.length === 1, "pipe connect");
    const big = { version: 1, id: "resp-big", type: "response", ok: true, payload: { data: "s".repeat(300 * 1024) } };
    h.stdin.write(encodeNativeMessage(big, "large-response"));
    await waitFor(
      () => h.sockets[0]?.framesWritten().some((frame) => (frame as { id?: unknown }).id === "resp-big") ?? false,
      "large extension response forwarded to pipe",
    );
    // Small traffic still flows afterwards: the relay is healthy.
    h.stdin.write(encodeNativeMessage({ version: 1, id: "ping-1", type: "request", method: "bridge.ping", payload: {} }));
    await waitFor(
      () => h.sockets[0]?.framesWritten().some((frame) => (frame as { id?: unknown }).id === "ping-1") ?? false,
      "small request forwarded after large response",
    );
    h.stdin.end();
    await expect(completed).resolves.toBe(0);
  });

  it("rejects a >16 MiB extension frame with typed fatal, bounded metadata, no body in logs", async () => {
    const h = hostHarness({ onSocket: (socket) => answerHello(socket) });
    const completed = runHost({ ...h.base, argv: [ORIGIN] });
    await waitFor(() => h.sockets.length === 1, "pipe connect");
    // Declared length only: no 16 MiB body is ever allocated or transmitted.
    h.stdin.write(headerOnly(LARGE + 1));
    await expect(completed).resolves.toBe(6);
    const logs = h.logs.join("\n");
    expect(logs).toContain("native framing error");
    expect(logs).toContain(String(LARGE + 1));
    expect(logs).not.toContain("s".repeat(64));
  });

  it("rejects an oversized server->extension request without crashing", async () => {
    const h = hostHarness({ onSocket: (socket) => answerHello(socket) });
    const completed = runHost({ ...h.base, argv: [ORIGIN] });
    await waitFor(() => h.sockets.length === 1, "pipe connect");
    // A >256 KiB frame arriving on the pipe (request direction) is rejected
    // at framing: the large-response allowance never applies here.
    const socket = h.sockets[0];
    if (socket === undefined) {
      throw new Error("expected a relay socket");
    }
    socket.emit("data", headerOnly(300 * 1024));
    await expect(completed).resolves.toBe(6);
    expect(h.logs.join("\n")).toContain("pipe framing error");
  });
});

describe("pipe server directions (real loopback pipe)", () => {
  it("decodes a >256 KiB relay event while small requests stay bounded", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-directional-"));
    try {
      const pipeName = `\\\\.\\pipe\\arc-mcp-directional-${String(process.pid)}`;
      const server = new McpPipeServer({ pipeName, sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      await server.start();
      const session = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));
      const socket = new net.Socket();
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("error", reject);
        socket.connect(pipeName);
      });
      const decoder = new NativeFrameDecoder("large-response");
      const frames: unknown[] = [];
      let closed = false;
      socket.on("data", (chunk: Buffer) => {
        frames.push(...decoder.push(chunk));
      });
      socket.on("close", () => {
        closed = true;
      });
      socket.write(
        encodeNativeMessage({
          version: 1,
          id: "h1",
          type: "request",
          method: "bridge.hello",
          payload: { nonce: session.nonceHex, bridgeVersion: 1 },
        }),
      );
      await waitFor(() => frames.some((frame) => (frame as { id?: unknown }).id === "h1"), "hello answer");
      // Large relay->server event decodes without closing the connection.
      socket.write(
        encodeNativeMessage(
          { version: 1, id: "ev-big", type: "event", method: "probe", payload: { blob: "e".repeat(300 * 1024) } },
          "large-response",
        ),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      expect(closed).toBe(false);
      // A >256 KiB server->relay request is rejected client-side at encode:
      // the small bound still governs the request direction.
      expect(() =>
        encodeNativeMessage(
          { version: 1, id: "q", type: "request", method: "page.screenshot", payload: { blob: "e".repeat(300 * 1024) } },
          "small",
        ),
      ).toThrow(BridgeError);
      socket.destroy();
      await server.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
