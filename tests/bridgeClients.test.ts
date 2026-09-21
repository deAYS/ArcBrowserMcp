import * as net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { McpPipeServer } from "../src/bridge/mcpPipeServer.js";
import { encodeNativeMessage, NativeFrameDecoder } from "../src/bridge/nativeFraming.js";
import { parseSessionDescriptor } from "../src/bridge/session.js";
import { BridgeRuntime } from "../src/browser/extension/BridgeRuntime.js";

let pipeSerial = 0;
function freshPipeName(): string {
  pipeSerial += 1;
  return `\\\\.\\pipe\\arc-mcp-clients-${String(process.pid)}-${String(pipeSerial)}`;
}

async function tempSessionDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-clients-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

interface RawClient {
  socket: net.Socket;
  decoder: NativeFrameDecoder;
  write: (value: unknown) => void;
}

/** Raw framed connection used to play the relay or a proxy client in tests. */
function openRaw(pipeName: string): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    const decoder = new NativeFrameDecoder();
    const client: RawClient = {
      socket,
      decoder,
      write: (value: unknown) => {
        socket.write(encodeNativeMessage(value));
      },
    };
    socket.on("connect", () => resolve(client));
    socket.on("error", reject);
    setTimeout(() => reject(new Error("raw connect timed out")), 5_000).unref?.();
  });
}

/** Collect frames; resolves when a predicate matches or the socket closes. */
function nextFrame(
  client: RawClient,
  match: (message: Record<string, unknown>) => boolean,
): Promise<{ message: Record<string, unknown> | null; closed: boolean }> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      for (const frame of client.decoder.push(chunk)) {
        const message = frame as Record<string, unknown>;
        if (match(message)) {
          client.socket.off("data", onData);
          resolve({ message, closed: false });
          return;
        }
      }
    };
    client.socket.on("data", onData);
    client.socket.on("close", () => {
      client.socket.off("data", onData);
      resolve({ message: null, closed: true });
    });
    setTimeout(() => {
      client.socket.off("data", onData);
      resolve({ message: null, closed: client.socket.destroyed });
    }, 5_000).unref?.();
  });
}

/**
 * Fake extension relay: authenticates, then echoes every forwarded request
 * back as an ok response carrying {echo: payload}.
 */
async function fakeRelay(pipeName: string, nonceHex: string): Promise<RawClient> {
  const client = await openRaw(pipeName);
  client.write({ version: 1, id: "h1", type: "request", method: "bridge.hello", payload: { nonce: nonceHex, bridgeVersion: 1 } });
  const hello = await nextFrame(client, (m) => m["type"] === "response" && m["id"] === "h1");
  if (hello.message === null || hello.message["ok"] !== true) {
    throw new Error("fake relay hello rejected");
  }
  const answerForever = async (): Promise<void> => {
    for (;;) {
      const incoming = await nextFrame(client, (m) => m["type"] === "request");
      if (incoming.message === null) {
        return;
      }
      client.write({
        version: 1,
        id: incoming.message["id"],
        type: "response",
        ok: true,
        payload: { echo: incoming.message["method"], payload: incoming.message["payload"] },
      });
    }
  };
  void answerForever();
  return client;
}

async function helloClient(client: RawClient, nonceHex: string): Promise<Record<string, unknown>> {
  client.write({
    version: 1,
    id: "c1",
    type: "request",
    method: "bridge.hello",
    payload: { nonce: nonceHex, bridgeVersion: 1 },
  });
  const outcome = await nextFrame(client, (m) => m["type"] === "response" && m["id"] === "c1");
  if (outcome.message === null) {
    throw new Error("client hello got no response (socket closed)");
  }
  return outcome.message["ok"] === true
    ? (outcome.message["payload"] as Record<string, unknown>)
    : outcome.message;
}

function waitClosed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
    setTimeout(() => resolve(), 3_000).unref?.();
  });
}

describe("owner clients pipe", () => {
  it("authenticates proxy clients with the session nonce and reports relay state", async () => {
    const { dir, cleanup } = await tempSessionDir();
    try {
      const pipeName = freshPipeName();
      const clientsPipeName = `${pipeName}-clients`;
      const server = new McpPipeServer({
        pipeName,
        sessionDir: dir,
        clientsPipeName,
        applyPipeAcl: () => Promise.resolve(),
      });
      await server.start();
      const session = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));

      const client = await openRaw(clientsPipeName);
      const hello = await helloClient(client, session.nonceHex);
      expect(hello["ok"]).toBe(true);
      expect(hello["relayConnected"]).toBe(false);
      expect(server.clientCount).toBe(1);

      // Relay joins after the client: the state event must reach it.
      // Attach the listener first: the push happens inside relay hello.
      const stateEventPromise = nextFrame(
        client,
        (m) => m["type"] === "event" && m["method"] === "bridge.relayState",
      );
      await fakeRelay(pipeName, session.nonceHex);
      const stateEvent = await stateEventPromise;
      expect(stateEvent.message).toMatchObject({ type: "event", method: "bridge.relayState", payload: { connected: true } });

      await server.stop();
    } finally {
      await cleanup();
    }
  });

  it("forwards authenticated client requests to the relay and returns the response", async () => {
    const { dir, cleanup } = await tempSessionDir();
    try {
      const pipeName = freshPipeName();
      const clientsPipeName = `${pipeName}-clients`;
      const server = new McpPipeServer({
        pipeName,
        sessionDir: dir,
        clientsPipeName,
        applyPipeAcl: () => Promise.resolve(),
      });
      await server.start();
      const session = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));
      await fakeRelay(pipeName, session.nonceHex);

      const client = await openRaw(clientsPipeName);
      await helloClient(client, session.nonceHex);
      client.write({
        version: 1,
        id: "req-1",
        type: "request",
        method: "tabs.list",
        payload: { marker: 42 },
      });
      const reply = await nextFrame(client, (m) => m["type"] === "response" && m["id"] === "req-1");
      expect(reply.message).toMatchObject({
        type: "response",
        ok: true,
        payload: { echo: "tabs.list", payload: { marker: 42 } },
      });

      await server.stop();
    } finally {
      await cleanup();
    }
  });

  it("rejects client requests before hello and destroys the connection", async () => {
    const { dir, cleanup } = await tempSessionDir();
    try {
      const pipeName = freshPipeName();
      const clientsPipeName = `${pipeName}-clients`;
      const server = new McpPipeServer({
        pipeName,
        sessionDir: dir,
        clientsPipeName,
        applyPipeAcl: () => Promise.resolve(),
      });
      await server.start();
      const client = await openRaw(clientsPipeName);
      client.write({ version: 1, id: "x", type: "request", method: "tabs.list", payload: {} });
      const outcome = await nextFrame(client, (m) => m["type"] === "response");
      expect(outcome.message).toMatchObject({ type: "response", ok: false, error: { code: "NOT_AUTHENTICATED" } });
      await waitClosed(client.socket);
      expect(client.socket.destroyed).toBe(true);
      await server.stop();
    } finally {
      await cleanup();
    }
  });

  it("rejects a wrong-nonce hello without authenticating", async () => {
    const { dir, cleanup } = await tempSessionDir();
    try {
      const pipeName = freshPipeName();
      const clientsPipeName = `${pipeName}-clients`;
      const server = new McpPipeServer({
        pipeName,
        sessionDir: dir,
        clientsPipeName,
        applyPipeAcl: () => Promise.resolve(),
      });
      await server.start();
      const client = await openRaw(clientsPipeName);
      const hello = await helloClient(client, "0".repeat(64));
      expect(hello["ok"]).toBe(false);
      expect(hello["error"]).toMatchObject({ code: "NOT_AUTHENTICATED" });
      expect(server.clientCount).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("defers the orphan reap while a proxy client is joined, then reaps on leave", async () => {
    const { dir, cleanup } = await tempSessionDir();
    try {
      const pipeName = freshPipeName();
      const clientsPipeName = `${pipeName}-clients`;
      let orphaned = 0;
      let idles = 0;
      const server = new McpPipeServer({
        pipeName,
        sessionDir: dir,
        clientsPipeName,
        applyPipeAcl: () => Promise.resolve(),
        parentPid: 2_147_483_647,
        orphanCheckIntervalMs: 10,
        isParentAlive: () => false,
        onOrphaned: () => {
          orphaned += 1;
        },
        onClientsIdle: () => {
          idles += 1;
        },
      });
      await server.start();
      const session = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));

      const client = await openRaw(clientsPipeName);
      await helloClient(client, session.nonceHex);
      // Parent dead + live client: the reap waits.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(orphaned).toBe(0);

      client.socket.destroy();
      await vi.waitFor(() => {
        expect(orphaned).toBe(1);
      });
      expect(idles).toBe(0);
      await server.stop();
    } finally {
      await cleanup();
    }
  });
});

describe("runtime own-or-join", () => {
  it("second runtime joins the owner and forwards requests through it", async () => {
    const { dir, cleanup } = await tempSessionDir();
    try {
      const pipeName = freshPipeName();
      const clientsPipeName = `${pipeName}-clients`;
      const noAcl = () => Promise.resolve();
      const owner = new BridgeRuntime({
        pipeName,
        sessionDir: dir,
        clientsPipeName,
        applyPipeAcl: noAcl,
      });
      await owner.start();
      const session = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));
      const relay = await fakeRelay(pipeName, session.nonceHex);
      await vi.waitFor(() => {
        expect(owner.isRelayConnected()).toBe(true);
      });

      const joiner = new BridgeRuntime({
        pipeName,
        sessionDir: dir,
        clientsPipeName,
        applyPipeAcl: noAcl,
      });
      await joiner.start();
      expect(joiner.isRelayConnected()).toBe(true);
      expect(owner.proxyClientCount()).toBe(1);

      const payload = (await joiner.request("tabs.list", { marker: 9 }, 5_000)) as {
        echo?: string;
        payload?: Record<string, unknown>;
      };
      expect(payload.echo).toBe("tabs.list");
      expect(payload.payload).toEqual({ marker: 9 });

      // Stop the joiner first: its deliberate proxy close must not trigger
      // a reconnect that would race this test's directory cleanup.
      await joiner.stop();
      relay.socket.destroy();
      await owner.stop();
    } finally {
      await cleanup();
    }
  });

  it("a joined runtime takes over the pipe when the owner stops", async () => {
    const { dir, cleanup } = await tempSessionDir();
    try {
      const pipeName = freshPipeName();
      const clientsPipeName = `${pipeName}-clients`;
      const noAcl = () => Promise.resolve();
      const owner = new BridgeRuntime({
        pipeName,
        sessionDir: dir,
        clientsPipeName,
        applyPipeAcl: noAcl,
      });
      await owner.start();
      const joiner = new BridgeRuntime({
        pipeName,
        sessionDir: dir,
        clientsPipeName,
        applyPipeAcl: noAcl,
      });
      await joiner.start();
      expect(joiner.isRelayConnected()).toBe(false);

      // Owner dies: the joiner must re-establish as the new owner.
      await owner.stop();
      await vi.waitFor(
        () => {
          expect(joiner.isRelayConnected()).toBe(false);
        },
        { timeout: 5_000 },
      );
      // New owner proof: a third runtime joins the takeover's clients pipe,
      // and the session file now belongs to the joiner's server.
      const third = new BridgeRuntime({
        pipeName,
        sessionDir: dir,
        clientsPipeName,
        applyPipeAcl: noAcl,
      });
      await third.start();
      const session = parseSessionDescriptor(await readFile(path.join(dir, "bridge-session.json"), "utf-8"));
      expect(session.pipeName).toBe(pipeName);
      expect(joiner.proxyClientCount()).toBe(1);
      expect(third.isRelayConnected()).toBe(false);

      // Stop the proxy first (no reconnect), then the owner.
      await third.stop();
      await joiner.stop();
    } finally {
      await cleanup();
    }
  });
});
