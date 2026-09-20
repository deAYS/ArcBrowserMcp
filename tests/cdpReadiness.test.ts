import * as net from "node:net";
import { describe, expect, it } from "vitest";
import { ArcError } from "../src/errors/ArcError.js";
import type { CdpFetch } from "../src/browser/cdp/CdpReadiness.js";
import { isTcpPortOccupied, waitForCdpReady } from "../src/browser/cdp/CdpReadiness.js";

const VERSION_PAYLOAD = {
  Browser: "Arc/1.2.3",
  "Protocol-Version": "1.3",
  webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/abc",
};

function jsonFetch(payload: unknown, status = 200): CdpFetch {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  });
}

function failingFetch(message: string): CdpFetch {
  return async () => {
    throw new Error(message);
  };
}

describe("waitForCdpReady", () => {
  it("returns version info when the endpoint is ready", async () => {
    const info = await waitForCdpReady(9333, {
      timeoutMs: 5_000,
      intervalMs: 10,
      perRequestTimeoutMs: 1_000,
      fetchImpl: jsonFetch(VERSION_PAYLOAD),
    });
    expect(info.browser).toBe("Arc/1.2.3");
    expect(info.protocolVersion).toBe("1.3");
    expect(info.webSocketDebuggerUrl).toContain("ws://127.0.0.1:9333");
  });

  it("tolerates malformed responses until a valid one arrives", async () => {
    let calls = 0;
    const fetchImpl: CdpFetch = async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, status: 200, json: () => Promise.resolve({ nope: true }) };
      }
      return { ok: false, status: 503, json: () => Promise.resolve({}) };
    };
    const second: CdpFetch = async () => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve(VERSION_PAYLOAD),
    });
    const combined: CdpFetch = async (url, init) => (calls < 2 ? fetchImpl(url, init) : second(url, init));
    const info = await waitForCdpReady(9333, {
      timeoutMs: 5_000,
      intervalMs: 10,
      perRequestTimeoutMs: 1_000,
      fetchImpl: combined,
    });
    expect(info.protocolVersion).toBe("1.3");
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("times out with ARC_CDP_READY_TIMEOUT and reports the last error", async () => {
    let caught: unknown = null;
    try {
      await waitForCdpReady(9334, {
        timeoutMs: 300,
        intervalMs: 50,
        perRequestTimeoutMs: 100,
        fetchImpl: failingFetch("connect ECONNREFUSED 127.0.0.1:9334"),
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ArcError);
    expect((caught as ArcError).code).toBe("ARC_CDP_READY_TIMEOUT");
    expect((caught as ArcError).details["lastError"] ?? "").toContain("ECONNREFUSED");
  });

  it("aborts with ARC_PROCESS_EXITED_EARLY when the owned process is gone", async () => {
    let caught: unknown = null;
    try {
      await waitForCdpReady(9334, {
        timeoutMs: 5_000,
        intervalMs: 10,
        perRequestTimeoutMs: 100,
        isAlive: () => false,
        describeExit: () => "code=1 signal=null",
        fetchImpl: failingFetch("irrelevant"),
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ArcError);
    expect((caught as ArcError).code).toBe("ARC_PROCESS_EXITED_EARLY");
  });
});

describe("isTcpPortOccupied", () => {
  it("detects a bound listener and a free port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a bound port");
    }
    expect(await isTcpPortOccupied("127.0.0.1", address.port)).toBe(true);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    expect(await isTcpPortOccupied("127.0.0.1", address.port)).toBe(false);
  });
});
