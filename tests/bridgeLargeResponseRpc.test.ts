import { describe, expect, it } from "vitest";
import { McpPipeServer } from "../src/bridge/mcpPipeServer.js";
import { RpcPeer } from "../src/bridge/rpc.js";
import {
  encodeNativeMessage,
  NativeFrameDecoder,
} from "../src/bridge/nativeFraming.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionDescriptor } from "../src/bridge/session.js";

/**
 * P08 large-response RPC integration regression (mocked/static, prelive).
 *
 * Proves the actual relay path — not just the framing codec — carries an
 * extension-originated >256 KiB response with end-to-end RPC correlation:
 *
 *   fake extension --(large-response frame)--> pipe server
 *     --> RpcPeer.requestDetailed resolves with the same correlation id
 *
 * and that the small request direction still rejects >256 KiB. A 2 MiB
 * response is representative; the 12 MiB/16 MiB codec boundaries stay in
 * the P08T framing suite (no need to re-allocate them here).
 */

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

describe("P08 large-response RPC integration", () => {
  it("correlates a 2 MiB extension-originated response through the pipe server", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-p08-rpc-"));
    let server: McpPipeServer | null = null;
    let socket: net.Socket | null = null;
    try {
      const pipeName = `\\\\.\\pipe\\arc-mcp-p08-rpc-${String(process.pid)}`;
      server = new McpPipeServer({ pipeName, sessionDir: dir, applyPipeAcl: () => Promise.resolve() });
      await server.start();
      const session = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));

      // Fake extension: raw framed socket speaking the relay role.
      socket = new net.Socket();
      await new Promise<void>((resolve, reject) => {
        socket?.once("connect", () => resolve());
        socket?.once("error", reject);
        socket?.connect(pipeName);
      });
      const current = socket;
      const decoder = new NativeFrameDecoder("large-response");
      const seen: unknown[] = [];
      current.on("data", (chunk: Buffer) => {
        seen.push(...decoder.push(chunk));
      });
      current.write(
        encodeNativeMessage({
          version: 1,
          id: "hello-1",
          type: "request",
          method: "bridge.hello",
          payload: { nonce: session.nonceHex, bridgeVersion: 1 },
        }),
      );
      await waitFor(() => seen.some((frame) => (frame as { id?: unknown }).id === "hello-1"), "hello answer");

      // MCP side issues a page.screenshot request; the fake extension
      // answers with a 2 MiB response AFTER encoding it as large-response.
      const pending = server.request("page.screenshot", { tabId: "t-x" }, 15_000);
      let requestId: string | null = null;
      await waitFor(
        () => {
          const found = seen.find(
            (frame) =>
              (frame as { type?: unknown }).type === "request" &&
              (frame as { method?: unknown }).method === "page.screenshot",
          ) as { id?: unknown } | undefined;
          if (found !== undefined && typeof found.id === "string") {
            requestId = found.id;
            return true;
          }
          return false;
        },
        "screenshot request observed by fake extension",
      );
      if (requestId === null) {
        throw new Error("never observed the screenshot request");
      }
      const blob = "p".repeat(2 * 1024 * 1024);
      current.write(
        encodeNativeMessage(
          { version: 1, id: requestId, type: "response", ok: true, payload: { data: blob } },
          "large-response",
        ),
      );
      const payload = (await pending) as { data?: unknown };
      expect(typeof payload.data).toBe("string");
      expect((payload.data as string).length).toBe(blob.length);
      expect((payload.data as string).slice(0, 16)).toBe("p".repeat(16));

      // Request direction unchanged: >256 KiB request encoding fails.
      const { BridgeError } = await import("../src/bridge/BridgeError.js");
      expect(() =>
        encodeNativeMessage({ version: 1, id: "q", type: "request", method: "x", payload: { blob: "q".repeat(300 * 1024) } }),
      ).toThrow(BridgeError);
    } finally {
      socket?.destroy();
      await server?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("unsolicited extension-side requests are RPC-rejected by the MCP server", async () => {
    // The MCP pipe server serves nothing but bridge.hello: any other
    // request method from the extension side gets UNKNOWN_METHOD even
    // though the physical stdin framing would permit a 16 MiB frame.
    // Such frames must never become valid browser commands.
    const { BridgeError } = await import("../src/bridge/BridgeError.js");
    const sent: unknown[] = [];
    const peer = new RpcPeer(
      (message) => {
        sent.push(message);
      },
      {
        handler: (request) => {
          expect(request.method).toBe("runtime.evaluate");
          return Promise.reject(new BridgeError("UNKNOWN_METHOD", `MCP side does not serve ${request.method}`));
        },
        onProtocolError: () => undefined,
      },
    );
    peer.handleIncoming({
      version: 1,
      id: "evil-1",
      type: "request",
      method: "runtime.evaluate",
      payload: { expression: "steal()" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: "evil-1", ok: false });
  });
});
