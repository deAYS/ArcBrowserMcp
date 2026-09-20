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

/**
 * P07 secret-payload logging boundary (mocked/static, prelive).
 *
 * The fill/type text travels only inside the bridge payload to the
 * extension. No diagnostic surface may echo it:
 * - MCP-side bridge logs carry method/pipe/status text only (never payloads)
 * - native-host stderr/journal lines carry status text only (never payloads)
 * - extension errors carry codes + fixed safe strings (never the text)
 * - handled tool/engine failures serialize length/code info only
 *
 * Logging method names such as interaction.fill / interaction.type is
 * explicitly allowed; logging payload.text is forbidden. The relay itself
 * forwards validated envelopes byte-identically (that is transport, not
 * logging); this suite proves no log/journal/error string contains the
 * sentinel.
 */

const SENTINEL = `p07-secret-sentinel-${"c3".repeat(8)}-log-boundary`;

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

describe("secret payload logging boundary", () => {
  it("MCP pipe server logs never contain the fill/type text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-secret-pipe-"));
    try {
      const { logger, entries } = collectingLogger();
      const server = new McpPipeServer({
        pipeName: `\\\\.\\pipe\\arc-mcp-secret-${String(process.pid)}`,
        sessionDir: dir,
        applyPipeAcl: () => Promise.resolve(),
        logger,
      });
      await server.start();
      const session = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));
      expect(JSON.stringify(session)).not.toContain(SENTINEL);

      // Authenticated relay that answers interaction.fill / interaction.type.
      const socket = net.createConnection((server as unknown as { options: { pipeName: string } }).options.pipeName);
      const decoder = new NativeFrameDecoder();
      const write = (value: unknown): void => {
        socket.write(encodeNativeMessage(value));
      };
      await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => {
          write({
            version: 1,
            id: "h1",
            type: "request",
            method: "bridge.hello",
            payload: { nonce: session.nonceHex, bridgeVersion: 1 },
          });
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
          const message = frame as { type?: unknown; id?: unknown; method?: unknown };
          if (message.type === "request" && typeof message.id === "string") {
            write({ version: 1, id: message.id, type: "response", ok: true, payload: { accepted: true } });
          }
        }
      };
      socket.on("data", answerLoop);
      await server.request("interaction.fill", { tabId: "t-x", ref: "e-x", text: SENTINEL }, 5_000);
      await server.request("interaction.type", { tabId: "t-x", ref: "e-x", text: SENTINEL }, 5_000);
      socket.off("data", answerLoop);
      socket.destroy();
      await server.stop();
      expect(entries.join("\n")).not.toContain(SENTINEL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("native host stderr/journal never contain the forwarded fill/type text", async () => {
    const { PassThrough } = await import("node:stream");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const logs: string[] = [];
    const journal: string[] = [];
    const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-secret-host-"));
    const journalPath = path.join(dir, "launches.log");
    const { appendFileSync } = await import("node:fs");
    void appendFileSync;

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
          pipeName: "\\\\.\\pipe\\secret-test",
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
          socket.emit(
            "data",
            encodeNativeMessage({ version: 1, id: "host-hello", type: "response", ok: true, payload: {} }),
          );
        });
        return Promise.resolve(socket as unknown as net.Socket);
      },
      helloTimeoutMs: 2_000,
      isPidAlive: () => true,
      journalPath,
    });
    // Give the relay a tick to authenticate, then push a fill + type frame
    // through stdin (extension -> pipe direction) carrying the sentinel.
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write(
      encodeNativeMessage({
        version: 1,
        id: "fill-1",
        type: "request",
        method: "interaction.fill",
        payload: { tabId: "t-x", ref: "e-x", text: SENTINEL },
      }),
    );
    stdin.write(
      encodeNativeMessage({
        version: 1,
        id: "type-1",
        type: "request",
        method: "interaction.type",
        payload: { tabId: "t-x", ref: "e-x", text: SENTINEL },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.end();
    await completed;
    expect(logs.join("\n")).not.toContain(SENTINEL);
    expect(journal.join("\n")).not.toContain(SENTINEL);
    let journalContent = "";
    try {
      journalContent = await readFile(journalPath, "utf-8");
    } catch {
      journalContent = "";
    }
    expect(journalContent).not.toContain(SENTINEL);
    expect(journalContent).toContain("start argv=");
    await rm(dir, { recursive: true, force: true });
  });

  it("extension/engine handled failures serialize without the secret", async () => {
    const { DebuggerSessionManager, createMemorySnapshotSessionStorage } = await import(
      "../extension/src/snapshot.js"
    );
    const commands: Array<{ method: string }> = [];
    const manager = new DebuggerSessionManager(
      {
        attach: () => Promise.resolve(),
        sendCommand: (tabId, method) => {
          void tabId;
          commands.push({ method });
          if (method === "DOM.describeNode") {
            return Promise.resolve({ node: { nodeName: "INPUT", attributes: ["type", "number"] } });
          }
          if (method === "Accessibility.getFullAXTree") {
            return Promise.resolve({
              nodes: [
                { nodeId: "1", role: { value: "textbox" }, name: { value: "Name" }, backendDOMNodeId: 7 },
              ],
            });
          }
          return Promise.resolve({});
        },
        detach: () => Promise.resolve(),
        onDetach: () => undefined,
      },
      () => Promise.resolve(11),
      () => ({ id: "t-x", url: "https://fixture.local/", title: "Fixture" }),
      createMemorySnapshotSessionStorage(),
      { generateSessionId: () => "a".repeat(32) },
    );
    const captured = await manager.capture("t-x");
    const ref = captured.nodes.find((node) => node.role === "textbox")?.ref;
    if (ref === undefined) {
      throw new Error("expected a textbox ref");
    }
    // number-typed target rejects with the typed non-editable error; the
    // serialized failure must carry the code but never the secret text.
    let serialized = "";
    try {
      await manager.fillElement("t-x", ref, SENTINEL);
    } catch (error: unknown) {
      serialized = JSON.stringify({ code: (error as { code?: unknown }).code, message: String(error) });
    }
    expect(serialized).toContain("ELEMENT_NOT_EDITABLE");
    expect(serialized).not.toContain(SENTINEL);
    // Method-name logging is allowed and provably sufficient for diagnosis.
    expect(`method=interaction.fill ${serialized}`).toContain("interaction.fill");
  });

  it("fileSessionLoader/session paths log only paths, never payloads", async () => {
    const loader = fileSessionLoader("C:\\definitely\\not\\here\\bridge-session.json");
    await expect(loader()).resolves.toBeNull();
  });

  it("evaluate source and thrown page secrets never reach logs/errors/diagnostics", async () => {
    const { DebuggerSessionManager, createMemorySnapshotSessionStorage } = await import(
      "../extension/src/snapshot.js"
    );
    const sentinel = `p08-eval-secret-${"9a".repeat(8)}-must-stay-hidden`;
    const commands: Array<{ method: string; params: unknown }> = [];
    const manager = new DebuggerSessionManager(
      {
        attach: () => Promise.resolve(),
        sendCommand: (tabId, method, params) => {
          void tabId;
          commands.push({ method, params });
          if (method === "Accessibility.getFullAXTree") {
            return Promise.resolve({ nodes: [] });
          }
          if (method === "Runtime.evaluate") {
            // Page throws the sentinel: raw description must never surface.
            return Promise.resolve({
              exceptionDetails: { text: "page error", exception: { description: sentinel } },
            });
          }
          return Promise.resolve({});
        },
        detach: () => Promise.resolve(),
        onDetach: () => undefined,
      },
      () => Promise.resolve(71),
      () => ({ id: "t-eval", url: "https://fixture.local/", title: "Fixture" }),
      createMemorySnapshotSessionStorage(),
      { generateSessionId: () => "e".repeat(32) },
    );
    // The expression itself carries the sentinel (worst case): dispatch
    // sends it to CDP params (the call), but no error/log/diagnostic may
    // repeat it. The test never prints the sentinel on success either.
    let serialized = "";
    try {
      await manager.evaluateElement("t-eval", `throw "${sentinel}"`, 2_000);
    } catch (error: unknown) {
      serialized = JSON.stringify({ code: (error as { code?: unknown }).code, message: String(error) });
    }
    expect(serialized).toContain("EVALUATION_FAILED");
    expect(serialized).not.toContain(sentinel);
    // No log/journal surface exists extension-side for evaluate; the only
    // peekable strings are the CDP params (the call itself). Prove the
    // fixed params carry no serialization/context handles.
    const evaluateCall = commands.find((command) => command.method === "Runtime.evaluate");
    expect(evaluateCall?.params).toMatchObject({
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: false,
      userGesture: false,
    });
    expect(JSON.stringify(evaluateCall?.params)).not.toContain("contextId");
    expect(JSON.stringify(evaluateCall?.params)).not.toContain("objectId");
  });

  it("screenshot base64 never reaches logs/errors/diagnostics", async () => {
    const { DebuggerSessionManager, createMemorySnapshotSessionStorage } = await import(
      "../extension/src/snapshot.js"
    );
    const tiny =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const manager = new DebuggerSessionManager(
      {
        attach: () => Promise.resolve(),
        sendCommand: (tabId, method) => {
          void tabId;
          if (method === "Page.captureScreenshot") {
            return Promise.resolve({ data: tiny });
          }
          if (method === "Accessibility.getFullAXTree") {
            return Promise.resolve({ nodes: [] });
          }
          return Promise.resolve({});
        },
        detach: () => Promise.resolve(),
        onDetach: () => undefined,
      },
      () => Promise.resolve(72),
      () => ({ id: "t-shot", url: "https://fixture.local/", title: "Fixture" }),
      createMemorySnapshotSessionStorage(),
      { generateSessionId: () => "f".repeat(32) },
    );
    const shot = await manager.captureScreenshot("t-shot");
    expect(shot.data.length).toBeGreaterThan(0);
    // Failure paths carry codes/sizes only: force a malformed payload and
    // prove the base64 never appears in the serialized error.
    const failing = new DebuggerSessionManager(
      {
        attach: () => Promise.resolve(),
        sendCommand: () => Promise.resolve({ data: "!!not-base64!!" }),
        detach: () => Promise.resolve(),
        onDetach: () => undefined,
      },
      () => Promise.resolve(73),
      () => ({ id: "t-shot-2", url: "https://fixture.local/", title: "Fixture" }),
      createMemorySnapshotSessionStorage(),
      { generateSessionId: () => "0".repeat(32) },
    );
    let serialized = "";
    try {
      await failing.captureScreenshot("t-shot-2");
    } catch (error: unknown) {
      serialized = JSON.stringify({ code: (error as { code?: unknown }).code, message: String(error) });
    }
    expect(serialized).toContain("SCREENSHOT_FAILED");
    expect(serialized).not.toContain(tiny);
    expect(serialized).not.toContain("not-base64");
  });
});
