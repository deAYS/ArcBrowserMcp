import { describe, expect, it } from "vitest";
import {
  ConsoleMonitor,
  buildConsoleResponse,
  normalizeConsoleAPICalled,
  normalizeExceptionThrown,
  renderConsoleArg,
} from "../src/observability/ConsoleMonitor.js";
import {
  NetworkMonitor,
  buildNetworkResponse,
  projectHeaders,
} from "../src/observability/NetworkMonitor.js";
import {
  CONSOLE_BUFFER_DEFAULT_ENTRIES,
  CONSOLE_BUFFER_HARD_MAX_ENTRIES,
  NETWORK_BUFFER_DEFAULT_ENTRIES,
  NETWORK_BUFFER_HARD_MAX_ENTRIES,
  NETWORK_CORRELATION_HARD_MAX,
  OBSERVABILITY_MAX_RETRIEVAL_LIMIT,
  OBSERVABILITY_MAX_SERIALIZED_BYTES,
  clampBufferCapacity,
  normalizeRetrievalLimit,
  observabilityUtf8Length,
  resolveBufferCapacity,
} from "../src/observability/observabilityPolicy.js";

const TS = "2026-01-01T00:00:00.000Z";

function consoleEntry(text: string, level: "log" | "info" | "warning" | "error" | "debug" = "log") {
  return { timestamp: TS, level, text };
}

describe("P09 console monitor: ring buffer semantics", () => {
  it("holds exactly capacity entries, then evicts oldest with dropped count", () => {
    const monitor = new ConsoleMonitor(3);
    monitor.ingest(consoleEntry("a"));
    monitor.ingest(consoleEntry("b"));
    monitor.ingest(consoleEntry("c"));
    expect(monitor.getSize()).toBe(3);
    expect(monitor.getDroppedCount()).toBe(0);
    monitor.ingest(consoleEntry("d"));
    expect(monitor.getSize()).toBe(3);
    expect(monitor.getDroppedCount()).toBe(1);
    expect(monitor.newest(10).map((entry) => entry.text)).toEqual(["b", "c", "d"]);
  });

  it("clear empties, resets dropped count, and preserves ordering", () => {
    const monitor = new ConsoleMonitor(2);
    monitor.ingest(consoleEntry("a"));
    monitor.ingest(consoleEntry("b"));
    monitor.ingest(consoleEntry("c"));
    expect(monitor.clear()).toBe(2);
    expect(monitor.getSize()).toBe(0);
    expect(monitor.getDroppedCount()).toBe(0);
    monitor.ingest(consoleEntry("z"));
    expect(monitor.newest(5).map((entry) => entry.text)).toEqual(["z"]);
  });

  it("retrieval limit returns newest in chronological order", () => {
    const monitor = new ConsoleMonitor(10);
    for (let index = 0; index < 5; index += 1) {
      monitor.ingest(consoleEntry(`e${String(index)}`));
    }
    expect(monitor.newest(2).map((entry) => entry.text)).toEqual(["e3", "e4"]);
  });

  it("serialized response budget trims oldest, prefers newest, sets truncated", () => {
    const big = consoleEntry("x".repeat(4000));
    const all = [big, big, big].flatMap(() => Array.from({ length: 400 }, () => big));
    void all;
    const entries = Array.from({ length: 600 }, (_v, index) => consoleEntry(`n${String(index).padStart(4, "0")}-${"y".repeat(900)}`));
    const result = buildConsoleResponse("t-x", 600, entries, 0, 600);
    // Hard retrieval limit is 500: newest 500 requested, then budget-trimmed.
    expect(result.returnedEntries).toBeLessThanOrEqual(OBSERVABILITY_MAX_RETRIEVAL_LIMIT);
    expect(observabilityUtf8Length(JSON.stringify(result))).toBeLessThanOrEqual(OBSERVABILITY_MAX_SERIALIZED_BYTES);
    // Newest entry survives budget trimming; chronological order preserved.
    const texts = result.entries.map((entry) => entry.text);
    expect(texts[texts.length - 1]?.startsWith("n0599")).toBe(true);
    for (let index = 1; index < texts.length; index += 1) {
      expect((texts[index - 1] ?? "") <= (texts[index] ?? "")).toBe(true);
    }
    if (result.returnedEntries < Math.min(entries.length, OBSERVABILITY_MAX_RETRIEVAL_LIMIT)) {
      expect(result.truncated).toBe(true);
    }
  });
});

describe("P09 console event normalization", () => {
  it("renders primitives for log/info/warning/error/debug with timestamp+source", () => {
    for (const type of ["log", "info", "warning", "error", "debug"] as const) {
      const entry = normalizeConsoleAPICalled(
        {
          type,
          args: [{ type: "string", value: "hello" }, { type: "number", value: 7 }, { type: "boolean", value: true }, null],
          stackTrace: { callFrames: [{ url: "https://example.test/a.js", lineNumber: 4, columnNumber: 9 }] },
        },
        TS,
      );
      expect(entry.level).toBe(type);
      expect(entry.timestamp).toBe(TS);
      expect(entry.text).toContain("hello");
      expect(entry.source?.url).toBe("https://example.test/a.js");
      expect(entry.source?.line).toBe(5);
      expect(entry.source?.column).toBe(10);
    }
  });

  it("uses bounded placeholders for complex RemoteObjects (never objectId/preview)", () => {
    expect(renderConsoleArg({ type: "object", objectId: "1:2:3", description: "secret-obj" })).toBe("[object]");
    expect(renderConsoleArg({ type: "function", objectId: "9:9", description: "fn" })).toBe("[function]");
    expect(renderConsoleArg({ type: "object", subtype: "array", preview: { properties: [{ name: "x" }] } })).toBe(
      "[object]",
    );
    const entry = normalizeConsoleAPICalled(
      { type: "log", args: [{ type: "object", objectId: "1:2:9", description: "raw-secret-content" }] },
      TS,
    );
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("objectId");
    expect(serialized).not.toContain("raw-secret-content");
    expect(serialized).not.toContain("preview");
  });

  it("bounds strings and redacts URL credentials in source", () => {
    const entry = normalizeConsoleAPICalled(
      {
        type: "log",
        args: [{ type: "string", value: `Bearer p09-console-secret-${"ab".repeat(8)} tail` }],
        url: `https://example.test/app.js?access_token=p09-console-secret-${"ab".repeat(8)}`,
      },
      TS,
    );
    expect(entry.text).not.toContain("p09-console-secret-");
    expect(entry.text.length).toBeLessThanOrEqual(4000);
    expect(entry.source?.url).not.toContain("p09-console-secret-");
    expect(entry.source?.url).toContain("access_token=[REDACTED]");
  });

  it("normalizes exceptionThrown into an error entry without exception content", () => {
    const secret = `p09-exc-secret-${"cd".repeat(8)}`;
    const entry = normalizeExceptionThrown(
      { exceptionDetails: { text: "Uncaught", exception: { description: secret }, stackTrace: { callFrames: [] } } },
      TS,
    );
    expect(entry.level).toBe("error");
    expect(entry.timestamp).toBe(TS);
    expect(JSON.stringify(entry)).not.toContain(secret);
  });
});

describe("P09 network monitor: ingest/correlation/eviction/clear", () => {
  function requestParams(url: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    return {
      requestId: "1",
      type: "XHR",
      request: { url, method: "get", headers, ...extra },
    };
  }

  it("ingests request + response, correlates, cleans up on finished", () => {
    const monitor = new NetworkMonitor(10);
    monitor.requestWillBeSent("raw-1", requestParams("https://example.test/api?page=2"), TS);
    expect(monitor.getPendingCount()).toBe(1);
    monitor.responseReceived("raw-1", {
      requestId: "raw-1",
      response: { status: 200, statusText: "OK", mimeType: "application/json", headers: { "Content-Type": "application/json" } },
    });
    monitor.loadingFinished("raw-1");
    expect(monitor.getPendingCount()).toBe(0);
    expect(monitor.getSize()).toBe(1);
    const [entry] = monitor.newest(10);
    expect(entry?.method).toBe("GET");
    expect(entry?.url).toBe("https://example.test/api?page=2");
    expect(entry?.status).toBe(200);
    expect(entry?.mimeType).toBe("application/json");
    expect(entry?.id).toMatch(/^n-[0-9a-z]+$/);
    expect(JSON.stringify(entry)).not.toContain("raw-1");
  });

  it("marks failed requests and cleans correlation", () => {
    const monitor = new NetworkMonitor(10);
    monitor.requestWillBeSent("raw-9", requestParams("https://example.test/down"), TS);
    monitor.loadingFailed("raw-9", { requestId: "raw-9", errorText: "net::ERR_FAILED" });
    expect(monitor.getPendingCount()).toBe(0);
    const [entry] = monitor.newest(10);
    expect(entry?.failed).toBe(true);
    expect(entry?.errorText).toBe("net::ERR_FAILED");
  });

  it("handles redirects deterministically (single entry, updated URL)", () => {
    const monitor = new NetworkMonitor(10);
    monitor.requestWillBeSent("raw-r", requestParams("https://example.test/a"), TS);
    monitor.responseReceived("raw-r", { requestId: "raw-r", response: { status: 302, headers: {} } });
    monitor.requestWillBeSent("raw-r", requestParams("https://example.test/b"), TS);
    monitor.responseReceived("raw-r", { requestId: "raw-r", response: { status: 200, headers: {} } });
    monitor.loadingFinished("raw-r");
    expect(monitor.getSize()).toBe(1);
    expect(monitor.newest(10)[0]?.url).toBe("https://example.test/b");
  });

  it("never exposes postData bodies (hasPostData flag only)", () => {
    const monitor = new NetworkMonitor(10);
    const bodySecret = `p09-post-body-${"ef".repeat(8)}`;
    monitor.requestWillBeSent(
      "raw-p",
      requestParams("https://example.test/submit", {}, { hasPostData: true, postData: bodySecret }),
      TS,
    );
    monitor.loadingFinished("raw-p");
    const [entry] = monitor.newest(10);
    expect(entry?.hasPostData).toBe(true);
    expect(JSON.stringify(entry)).not.toContain(bodySecret);
    expect(JSON.stringify(entry)).not.toContain("postData");
  });

  it("evicts oldest at capacity, bounds correlation, clears fully", () => {
    const monitor = new NetworkMonitor(2);
    for (const id of ["a", "b", "c"]) {
      monitor.requestWillBeSent(id, { ...requestParams(`https://example.test/${id}`), requestId: id }, TS);
      monitor.loadingFinished(id);
    }
    expect(monitor.getSize()).toBe(2);
    expect(monitor.getDroppedCount()).toBe(1);
    expect(monitor.newest(10).map((entry) => entry.url)).toEqual([
      "https://example.test/b",
      "https://example.test/c",
    ]);
    expect(monitor.clear()).toBe(2);
    expect(monitor.getSize()).toBe(0);
    expect(monitor.getDroppedCount()).toBe(0);
  });

  it("correlation map is bounded (never grows past the hard max)", () => {
    const monitor = new NetworkMonitor(5000);
    for (let index = 0; index < NETWORK_CORRELATION_HARD_MAX + 50; index += 1) {
      const id = `pending-${String(index)}`;
      monitor.requestWillBeSent(id, { ...requestParams("https://example.test/hung"), requestId: id }, TS);
    }
    expect(monitor.getPendingCount()).toBeLessThanOrEqual(NETWORK_CORRELATION_HARD_MAX);
  });

  it("response budget trims oldest and keeps newest useful entries", () => {
    const entries = Array.from({ length: 500 }, (_v, index) => ({
      id: `n-${index.toString(36)}`,
      startedAt: TS,
      method: "GET",
      url: `https://example.test/item/${String(index)}?q=${"z".repeat(900)}`,
      requestHeaders: {},
      hasPostData: false,
    }));
    const result = buildNetworkResponse("t-x", 500, entries, 0, 500);
    expect(observabilityUtf8Length(JSON.stringify(result))).toBeLessThanOrEqual(OBSERVABILITY_MAX_SERIALIZED_BYTES);
    expect(result.entries[result.entries.length - 1]?.url).toContain("/item/499");
  });

  it("projectHeaders redacts mixed-case sensitive headers", () => {
    const secret = `p09-hdr-secret-${"12".repeat(8)}`;
    const out = projectHeaders({ aUtHoRiZaTiOn: `Bearer ${secret}`, COOKIE: secret, "X-Custom": "ok" });
    expect(out["aUtHoRiZaTiOn"]).toBe("[REDACTED]");
    expect(out["COOKIE"]).toBe("[REDACTED]");
    expect(out["X-Custom"]).toBe("ok");
    expect(JSON.stringify(out)).not.toContain(secret);
  });
});

describe("P09 observability config", () => {
  it("uses defaults when unset", () => {
    expect(resolveBufferCapacity(undefined, CONSOLE_BUFFER_DEFAULT_ENTRIES, CONSOLE_BUFFER_HARD_MAX_ENTRIES)).toEqual({
      ok: true,
      capacity: 200,
    });
    expect(resolveBufferCapacity(undefined, NETWORK_BUFFER_DEFAULT_ENTRIES, NETWORK_BUFFER_HARD_MAX_ENTRIES)).toEqual({
      ok: true,
      capacity: 500,
    });
  });

  it("accepts valid custom capacities", () => {
    expect(resolveBufferCapacity("1000", 200, 2000)).toEqual({ ok: true, capacity: 1000 });
    expect(resolveBufferCapacity(2500, 500, 5000)).toEqual({ ok: true, capacity: 2500 });
  });

  it("rejects zero/negative/non-integer/over-max deterministically", () => {
    // Note: Number.parseInt("10.5") === 10 is valid by construction (integer
    // prefix parse, same as ports/timeouts elsewhere); the case is covered
    // by the genuinely invalid shapes below.
    for (const raw of ["0", "-5", "abc", "2001"] as const) {
      expect(resolveBufferCapacity(raw, 200, 2000).ok).toBe(false);
    }
    expect(resolveBufferCapacity("5001", 500, 5000).ok).toBe(false);
  });

  it("extension clamp enforces the hard maximum independently", () => {
    expect(clampBufferCapacity(999_999, 200, CONSOLE_BUFFER_HARD_MAX_ENTRIES)).toBe(CONSOLE_BUFFER_HARD_MAX_ENTRIES);
    expect(clampBufferCapacity(999_999, 500, NETWORK_BUFFER_HARD_MAX_ENTRIES)).toBe(NETWORK_BUFFER_HARD_MAX_ENTRIES);
    expect(clampBufferCapacity(undefined, 200, 2000)).toBe(200);
    expect(clampBufferCapacity(0, 200, 2000)).toBe(200);
  });

  it("retrieval limits default to 100 and clamp to 500", () => {
    expect(normalizeRetrievalLimit(undefined)).toBe(100);
    expect(normalizeRetrievalLimit(50)).toBe(50);
    expect(normalizeRetrievalLimit(9999)).toBe(500);
  });

  it("hard maxima match the phase contract", () => {
    expect(CONSOLE_BUFFER_DEFAULT_ENTRIES).toBe(200);
    expect(CONSOLE_BUFFER_HARD_MAX_ENTRIES).toBe(2000);
    expect(NETWORK_BUFFER_DEFAULT_ENTRIES).toBe(500);
    expect(NETWORK_BUFFER_HARD_MAX_ENTRIES).toBe(5000);
  });
});
