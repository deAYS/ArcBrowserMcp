import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import type { BridgeMessage } from "../src/bridge/protocol.js";
import { RpcPeer } from "../src/bridge/rpc.js";

function loopingPeer(options?: ConstructorParameters<typeof RpcPeer>[1]): { peer: RpcPeer; sent: BridgeMessage[] } {
  const sent: BridgeMessage[] = [];
  const peer = new RpcPeer((message) => {
    sent.push(message);
  }, options);
  return { peer, sent };
}

describe("RpcPeer correlation", () => {
  it("matches out-of-order responses to concurrent requests", async () => {
    const { peer, sent } = loopingPeer({ generateId: (() => {
      let n = 0;
      return () => `id-${String((n += 1))}`;
    })() });
    const first = peer.request("bridge.ping", { n: 1 });
    const second = peer.request("bridge.status", { n: 2 });
    expect(sent.map((message) => message.id)).toEqual(["id-1", "id-2"]);
    peer.handleIncoming({ version: 1, id: "id-2", type: "response", ok: true, payload: { s: 2 } });
    peer.handleIncoming({ version: 1, id: "id-1", type: "response", ok: true, payload: { p: 1 } });
    await expect(first).resolves.toEqual({ p: 1 });
    await expect(second).resolves.toEqual({ s: 2 });
    expect(peer.pendingCount).toBe(0);
  });

  it("delivers structured errors for failed and unknown methods", async () => {
    const { peer, sent } = loopingPeer({
      handler: (request) => {
        if (request.method === "bridge.boom") {
          return Promise.reject(new BridgeError("TIMEOUT", "boom"));
        }
        return Promise.resolve({ hello: true });
      },
    });
    // Unknown method without a matching handler path still answers structurally.
    const strict = loopingPeer();
    strict.peer.handleIncoming({ version: 1, id: "u1", type: "request", method: "nope", payload: {} });
    expect(strict.sent).toHaveLength(1);
    const answer = strict.sent[0];
    expect(answer?.type).toBe("response");
    expect(answer).toMatchObject({ id: "u1", ok: false });

    peer.handleIncoming({ version: 1, id: "e1", type: "request", method: "bridge.boom", payload: {} });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: "e1", ok: false });
    if (sent[0]?.type === "response" && !sent[0].ok) {
      expect(sent[0].error.code).toBe("TIMEOUT");
    } else {
      throw new Error("expected error response");
    }
  });

  it("rejects unknown protocol versions without touching the handler", async () => {
    let protocolErrors = 0;
    let handled = 0;
    const { peer } = loopingPeer({
      handler: () => {
        handled += 1;
        return Promise.resolve({});
      },
      onProtocolError: () => {
        protocolErrors += 1;
      },
    });
    peer.handleIncoming({ version: 99, id: "v1", type: "request", method: "bridge.ping", payload: {} });
    expect(protocolErrors).toBe(1);
    expect(handled).toBe(0);
  });

  it("rejects malformed envelopes without touching the handler", async () => {
    let protocolErrors = 0;
    let handled = 0;
    const { peer } = loopingPeer({
      handler: () => {
        handled += 1;
        return Promise.resolve({});
      },
      onProtocolError: () => {
        protocolErrors += 1;
      },
    });
    peer.handleIncoming({ version: 1, type: "request", payload: {} });
    peer.handleIncoming("just a string");
    expect(protocolErrors).toBe(2);
    expect(handled).toBe(0);
  });

  it("times out pending requests and cleans up", async () => {
    const { peer } = loopingPeer({ defaultTimeoutMs: 30 });
    let caught: unknown = null;
    try {
      await peer.request("bridge.ping", {});
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe("TIMEOUT");
    expect(peer.pendingCount).toBe(0);
  });

  it("close() rejects pendings and unknown responses are reported", async () => {
    let protocolErrors = 0;
    const { peer } = loopingPeer({ onProtocolError: () => {
      protocolErrors += 1;
    } });
    const pending = peer.request("bridge.ping", {}, 5_000);
    peer.close(new BridgeError("NOT_CONNECTED", "going away"));
    await expect(pending).rejects.toBeInstanceOf(BridgeError);
    peer.handleIncoming({ version: 1, id: "ghost", type: "response", ok: true, payload: {} });
    expect(protocolErrors).toBe(1);
  });

  it("forwards events to the subscriber", async () => {
    const seen: Array<{ method: string; id: string }> = [];
    const { peer } = loopingPeer({
      onEvent: (method, _payload, id) => {
        seen.push({ method, id });
      },
    });
    peer.handleIncoming({ version: 1, id: "ev-1", type: "event", method: "bridge.status", payload: {} });
    expect(seen).toEqual([{ method: "bridge.status", id: "ev-1" }]);
  });
});
