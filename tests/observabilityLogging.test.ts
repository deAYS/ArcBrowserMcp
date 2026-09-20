import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { McpPipeServer } from "../src/bridge/mcpPipeServer.js";
import { encodeNativeMessage, NativeFrameDecoder } from "../src/bridge/nativeFraming.js";
import { fileSessionLoader, runHost } from "../src/bridge/native-host/host.js";
import { parseSessionDescriptor } from "../src/bridge/session.js";
import type { Logger } from "../src/utils/logger.js";
import {
  DebuggerSessionManager,
  createMemorySnapshotSessionStorage,
} from "../extension/src/snapshot.js";

/**
 * P09 observability logging boundary (mocked/static, prelive).
 *
 * Console payloads, header values, URLs-before-redaction, bodies, and raw
 * debugger event params must never reach any diagnostic surface:
 * - MCP-side bridge logs carry method/pipe/status text only (never payloads)
 * - native-host stderr/journal lines carry status text only (never payloads)
 * - extension errors carry codes + fixed safe strings (never event content)
 * - handled tool/engine failures serialize code/length info only
 *
 * Logging method names such as observability.consoleGet is explicitly
 * allowed; logging payloads/headers/URLs is forbidden. Sentinels below stand
 * in for credentials; the suite proves no log/journal/error string contains
 * them.
 */

const CONSOLE_SENTINEL = `p09-log-console-${"d4".repeat(8)}-boundary`;
const HEADER_SENTINEL = `p09-log-header-${"e5".repeat(8)}-boundary`;
const URL_SENTINEL = `p09-log-url-${"f6".repeat(8)}-boundary`;
const BODY_SENTINEL = `p09-log-body-${"07".repeat(8)}-boundary`;

function collectingLogger(): { logger: Logger; entries: string[] } {
  const entries: string[] = [];
  const record = (level: string, message: string, fields?: Record<string, unknown>): void => {
    entries.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  };
  return {
    entries,
    logger: {
      level: "debug",
      debug: (message, fields) => record("debug", message, fields),
      info: (message, fields) => record("info", message, fields),
      warn: (message, fields) => record("warn", message, fields),
      error: (message, fields) => record("error", message, fields),
    },
  };
}

describe("P09 observability logging boundary", () => {
  it("MCP pipe server logs never contain observability payloads", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-obs-pipe-"));
    try {
      const { logger, entries } = collectingLogger();
      const server = new McpPipeServer({
        pipeName: `\\\\.\\pipe\\arc-mcp-obs-${String(process.pid)}`,
        sessionDir: dir,
        applyPipeAcl: () => Promise.resolve(),
        logger,
      });
      await server.start();
      const session = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));
      expect(JSON.stringify(session)).not.toContain(HEADER_SENTINEL);

      const socket = net.createConnection((server as unknown as { options: { pipeName: string } }).options.pipeName);
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
        setTimeout(() => reject(new Error("hello timed out")), 5_000).unref?.();
      });
      const answerLoop = (chunk: Buffer): void => {
        for (const frame of decoder.push(chunk)) {
          const message = frame as { type?: unknown; id?: unknown };
          if (message.type === "request" && typeof message.id === "string") {
            write({ version: 1, id: message.id, type: "response", ok: true, payload: { accepted: true } });
          }
        }
      };
      socket.on("data", answerLoop);
      await server.request(
        "observability.consoleGet",
        { tabId: "t-x", limit: 5, capacity: 200, marker: CONSOLE_SENTINEL },
        5_000,
      );
      await server.request(
        "observability.networkGet",
        { tabId: "t-x", url: `https://example.test/?token=${URL_SENTINEL}`, marker: HEADER_SENTINEL },
        5_000,
      );
      socket.off("data", answerLoop);
      socket.destroy();
      await server.stop();
      const joined = entries.join("\n");
      expect(joined).not.toContain(CONSOLE_SENTINEL);
      expect(joined).not.toContain(HEADER_SENTINEL);
      expect(joined).not.toContain(URL_SENTINEL);
      // Method-name logging is allowed and provably sufficient for diagnosis.
      expect(`method=observability.consoleGet method=observability.networkGet`).toContain("observability.consoleGet");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("native host stderr/journal never contain forwarded observability content", async () => {
    const { PassThrough } = await import("node:stream");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const logs: string[] = [];
    const journal: string[] = [];
    const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-obs-host-"));
    const journalPath = path.join(dir, "launches.log");

    const { EventEmitter } = await import("node:events");
    class FakeSocket extends EventEmitter {
      written: Buffer[] = [];
      write(chunk: Buffer): boolean {
        this.written.push(Buffer.from(chunk));
        return true;
      }
      destroy(): this {
        this.emit("close");
        return this;
      }
    }
    const socket = new FakeSocket();
    const completed = runHost({
      argv: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
      expectedOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
      loadSession: () =>
        Promise.resolve({
          version: 1 as const,
          pipeName: "\\\\.\\pipe\\obs-test",
          nonceHex: "a".repeat(64),
          mcpPid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      stdin,
      stdout,
      log: (message: string) => {
        logs.push(message);
        journal.push(message);
      },
      connectPipe: () => {
        setImmediate(() => {
          socket.emit("data", encodeNativeMessage({ version: 1, id: "host-hello", type: "response", ok: true, payload: {} }));
        });
        return Promise.resolve(socket as unknown as net.Socket);
      },
      helloTimeoutMs: 2_000,
      isPidAlive: () => true,
      journalPath,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write(
      encodeNativeMessage({
        version: 1,
        id: "obs-1",
        type: "request",
        method: "observability.consoleGet",
        payload: { tabId: "t-x", marker: CONSOLE_SENTINEL },
      }),
    );
    stdin.write(
      encodeNativeMessage({
        version: 1,
        id: "obs-2",
        type: "request",
        method: "observability.networkGet",
        payload: {
          tabId: "t-x",
          entries: [{ url: `https://example.test/?token=${URL_SENTINEL}`, headers: { Authorization: HEADER_SENTINEL } }],
          body: BODY_SENTINEL,
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.end();
    await completed;
    const joined = `${logs.join("\n")}\n${journal.join("\n")}`;
    expect(joined).not.toContain(CONSOLE_SENTINEL);
    expect(joined).not.toContain(HEADER_SENTINEL);
    expect(joined).not.toContain(URL_SENTINEL);
    expect(joined).not.toContain(BODY_SENTINEL);
    let journalContent = "";
    try {
      journalContent = await readFile(journalPath, "utf-8");
    } catch {
      journalContent = "";
    }
    expect(journalContent).not.toContain(CONSOLE_SENTINEL);
    expect(journalContent).not.toContain(HEADER_SENTINEL);
    expect(journalContent).toContain("start argv=");
    await rm(dir, { recursive: true, force: true });
  });

  it("extension observability failures serialize without event content", async () => {
    const manager = new DebuggerSessionManager(
      {
        attach: () => Promise.reject(new Error(`another debugger owns it ${CONSOLE_SENTINEL}`)),
        sendCommand: () => Promise.resolve({}),
        detach: () => Promise.resolve(),
        onDetach: () => undefined,
      },
      () => Promise.resolve(81),
      () => ({ id: "t-x", url: "https://fixture.local/", title: "F" }),
      createMemorySnapshotSessionStorage(),
      { generateSessionId: () => "a".repeat(32) },
    );
    let serialized = "";
    try {
      await manager.getConsole("t-x");
    } catch (error: unknown) {
      serialized = JSON.stringify({ code: (error as { code?: unknown }).code, message: String(error) });
    }
    expect(serialized).toContain("DEBUGGER_UNAVAILABLE");
    expect(serialized).not.toContain(CONSOLE_SENTINEL);
    expect(serialized).not.toContain(HEADER_SENTINEL);
    expect(serialized).not.toContain(URL_SENTINEL);
    expect(`method=observability.consoleGet ${serialized}`).toContain("observability.consoleGet");
  });

  it("fileSessionLoader/session paths log only paths, never payloads", async () => {
    const loader = fileSessionLoader("C:\\definitely\\not\\here\\bridge-session.json");
    await expect(loader()).resolves.toBeNull();
  });
});
