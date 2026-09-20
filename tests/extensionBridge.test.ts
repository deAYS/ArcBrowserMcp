import { describe, expect, it, vi } from "vitest";
import type { NativePort } from "../extension/src/bridge.js";
import { ExtensionBridge, reconnectDelayMs } from "../extension/src/bridge.js";

interface MockPort extends NativePort {
  posted: unknown[];
  messageListeners: Array<(message: unknown) => void>;
  disconnectListeners: Array<() => void>;
  disconnects: number;
  errorToReport: string | undefined;
  peerAnswer(message: unknown): void;
}

function mockPort(): MockPort {
  const port: MockPort = {
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
    peerAnswer: (message: unknown) => {
      for (const listener of [...port.messageListeners]) {
        listener(message);
      }
    },
  };
  return port;
}

describe("reconnectDelayMs", () => {
  it("backs off exponentially with a cap and no tight loop", () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(1)).toBe(1_000);
    expect(reconnectDelayMs(2)).toBe(2_000);
    expect(reconnectDelayMs(10)).toBe(10_000);
    expect(reconnectDelayMs(100)).toBe(10_000);
  });
});

describe("ExtensionBridge", () => {
  it("connects, answers ping with the same id, and reports status", async () => {
    const port = mockPort();
    const bridge = new ExtensionBridge(() => port, { generateId: () => "req-1" });
    bridge.onRemoteRequest((method) => {
      if (method === "bridge.ping") {
        return { pong: true };
      }
      throw new Error(`unknown ${method}`);
    });
    bridge.ensureConnected();
    expect(bridge.getStatus()).toMatchObject({ connected: true, attempts: 0 });

    port.peerAnswer({ version: 1, id: "ping-9", type: "request", method: "bridge.ping", payload: {} });
    await vi.waitFor(() => {
      expect(port.posted).toHaveLength(1);
    });
    expect(port.posted[0]).toMatchObject({ version: 1, id: "ping-9", type: "response", ok: true });
  });

  it("answers unknown methods with a structured error", async () => {
    const port = mockPort();
    const bridge = new ExtensionBridge(() => port);
    bridge.onRemoteRequest(() => {
      throw new Error("nope");
    });
    bridge.ensureConnected();
    port.peerAnswer({ version: 1, id: "m-1", type: "request", method: "browser.tabs", payload: {} });
    await vi.waitFor(() => {
      expect(port.posted).toHaveLength(1);
    });
    expect(port.posted[0]).toMatchObject({ id: "m-1", ok: false });
  });

  it("rejects a second onRemoteRequest registration (single dispatcher invariant)", () => {
    const port = mockPort();
    const bridge = new ExtensionBridge(() => port);
    bridge.onRemoteRequest(() => ({ ok: true }));
    expect(() => bridge.onRemoteRequest(() => ({ ok: true }))).toThrow(
      "bridge request handler already registered",
    );
  });

  it("preserves typed handler error codes and defaults untyped to UNKNOWN_METHOD", async () => {
    const typedPort = mockPort();
    const typed = new ExtensionBridge(() => typedPort);
    typed.onRemoteRequest(() => {
      const error = new Error("tab gone") as Error & { code: string };
      error.code = "TAB_NOT_FOUND";
      throw error;
    });
    typed.ensureConnected();
    typedPort.peerAnswer({ version: 1, id: "t-1", type: "request", method: "tabs.close", payload: {} });
    await vi.waitFor(() => {
      expect(typedPort.posted).toHaveLength(1);
    });
    expect(typedPort.posted[0]).toMatchObject({ id: "t-1", ok: false });
    const typedAnswer = typedPort.posted[0] as {
      error?: { code?: string };
    };
    expect(typedAnswer.error?.code).toBe("TAB_NOT_FOUND");

    const plainPort = mockPort();
    const plain = new ExtensionBridge(() => plainPort);
    plain.onRemoteRequest(() => {
      throw new Error("boom");
    });
    plain.ensureConnected();
    plainPort.peerAnswer({ version: 1, id: "t-2", type: "request", method: "tabs.close", payload: {} });
    await vi.waitFor(() => {
      expect(plainPort.posted).toHaveLength(1);
    });
    const plainAnswer = plainPort.posted[0] as {
      error?: { code?: string };
    };
    expect(plainAnswer.error?.code).toBe("UNKNOWN_METHOD");
  });

  it("reconnects with backoff after disconnect and recovers", async () => {
    vi.useFakeTimers();
    try {
      let livePort: MockPort | undefined;
      const ports: MockPort[] = [];
      const bridge = new ExtensionBridge(() => {
        const port = mockPort();
        livePort = port;
        ports.push(port);
        return port;
      }, { baseDelayMs: 50, maxDelayMs: 200 });
      bridge.ensureConnected();
      expect(bridge.getStatus().connected).toBe(true);
      if (livePort === undefined) {
        throw new Error("expected a live port");
      }
      livePort.errorToReport = "host gone";
      for (const listener of [...livePort.disconnectListeners]) {
        listener();
      }
      expect(bridge.getStatus()).toMatchObject({ connected: false, attempts: 1, lastError: "host gone" });
      // First retry would fire at 100ms (attempt 1 -> 50*2); advance past it.
      await vi.advanceTimersByTimeAsync(150);
      expect(ports).toHaveLength(2);
      expect(bridge.getStatus().connected).toBe(true);
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("close() stops retries and disconnects the port", async () => {
    vi.useFakeTimers();
    try {
      const ports: MockPort[] = [];
      const bridge = new ExtensionBridge(() => {
        const port = mockPort();
        ports.push(port);
        return port;
      }, { baseDelayMs: 50, maxDelayMs: 100 });
      bridge.ensureConnected();
      bridge.close();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ports).toHaveLength(1);
      expect(ports[0]?.disconnects).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
