import { describe, expect, it } from "vitest";
import {
  DebuggerSessionManager,
  createMemorySnapshotSessionStorage,
  type DebuggerChrome,
  type SnapshotTabRecord,
} from "../extension/src/snapshot.js";

const SESSION = "f".repeat(32);
const PROJECT = `t-${"f".repeat(32)}-71`;
const TS_HINT = "2026-01-01T00:00:00.000Z";

function axTree(): Record<string, unknown>[] {
  return [
    { nodeId: "1", role: { value: "heading" }, name: { value: "P09 Fixture" }, backendDOMNodeId: 701 },
  ];
}

interface Harness {
  manager: DebuggerSessionManager;
  commands: Array<{ method: string; params: Record<string, unknown> | undefined }>;
}

function harness(): Harness {
  const commands: Harness["commands"] = [];
  const records = new Map<number, SnapshotTabRecord>([[71, { id: PROJECT, url: "https://fixture.local/", title: "F" }]]);
  const debuggerChrome: DebuggerChrome = {
    attach: () => Promise.resolve(),
    sendCommand: (_t, method, params) => {
      commands.push({ method, params });
      if (method === "Accessibility.getFullAXTree") {
        return Promise.resolve({ nodes: axTree() });
      }
      return Promise.resolve({});
    },
    detach: () => Promise.resolve(),
    onDetach: () => undefined,
  };
  const manager = new DebuggerSessionManager(
    debuggerChrome,
    (projectId) =>
      projectId === PROJECT ? Promise.resolve(71) : Promise.reject(Object.assign(new Error("x"), { code: "TAB_INVALID_ID" })),
    (chromeId) => records.get(chromeId) ?? null,
    createMemorySnapshotSessionStorage(),
    { generateSessionId: () => SESSION },
  );
  return { manager, commands };
}

const AUTH_SECRET = `p09-route-auth-${"aa".repeat(8)}`;
const URL_SECRET = `p09-route-url-${"bb".repeat(8)}`;

describe("P09 event routing", () => {
  it("ingests consoleAPICalled levels/primitives with timestamp+source", async () => {
    const fixture = harness();
    await fixture.manager.ensureConsoleMonitoring(PROJECT);
    fixture.manager.handleDebuggerEvent(71, "Runtime.consoleAPICalled", {
      type: "warning",
      args: [{ type: "string", value: "route-marker" }, { type: "number", value: 3 }],
      stackTrace: { callFrames: [{ url: "https://fixture.local/app.js", lineNumber: 1, columnNumber: 2 }] },
    });
    const result = await fixture.manager.getConsole(PROJECT);
    expect(result.availableEntries).toBe(1);
    expect(result.entries[0]?.level).toBe("warning");
    expect(result.entries[0]?.text).toContain("route-marker");
    expect(typeof result.entries[0]?.timestamp).toBe("string");
    expect(result.entries[0]?.source?.url).toBe("https://fixture.local/app.js");
    expect(JSON.stringify(result)).not.toContain("objectId");
    expect(JSON.stringify(result)).not.toContain("executionContextId");
  });

  it("normalizes exceptionThrown into an error entry without raw content", async () => {
    const fixture = harness();
    await fixture.manager.ensureConsoleMonitoring(PROJECT);
    fixture.manager.handleDebuggerEvent(71, "Runtime.exceptionThrown", {
      exceptionDetails: { text: "Uncaught boom", exception: { description: AUTH_SECRET } },
    });
    const result = await fixture.manager.getConsole(PROJECT);
    expect(result.entries[0]?.level).toBe("error");
    expect(JSON.stringify(result)).not.toContain(AUTH_SECRET);
  });

  it("ingests network request/response/finish with redacted metadata", async () => {
    const fixture = harness();
    await fixture.manager.ensureNetworkMonitoring(PROJECT);
    fixture.manager.handleDebuggerEvent(71, "Network.requestWillBeSent", {
      requestId: "raw-500",
      type: "Fetch",
      request: {
        url: `https://example.test/api?access_token=${URL_SECRET}&page=2`,
        method: "post",
        headers: { Authorization: `Bearer ${AUTH_SECRET}`, "X-Ok": "yes" },
        hasPostData: true,
        postData: "SHOULD-NEVER-BE-COLLECTED",
      },
    });
    fixture.manager.handleDebuggerEvent(71, "Network.responseReceived", {
      requestId: "raw-500",
      response: { status: 200, statusText: "OK", mimeType: "application/json", headers: { "Set-Cookie": AUTH_SECRET } },
    });
    fixture.manager.handleDebuggerEvent(71, "Network.loadingFinished", { requestId: "raw-500" });
    const result = await fixture.manager.getNetwork(PROJECT);
    expect(result.availableEntries).toBe(1);
    const entry = result.entries[0];
    expect(entry?.method).toBe("POST");
    expect(entry?.status).toBe(200);
    expect(entry?.url).toContain("page=2");
    expect(entry?.url).toContain("access_token=[REDACTED]");
    expect(entry?.requestHeaders["Authorization"]).toBe("[REDACTED]");
    expect(entry?.responseHeaders?.["Set-Cookie"]).toBe("[REDACTED]");
    expect(entry?.hasPostData).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(AUTH_SECRET);
    expect(serialized).not.toContain(URL_SECRET);
    expect(serialized).not.toContain("raw-500");
    expect(serialized).not.toContain("SHOULD-NEVER-BE-COLLECTED");
    expect(serialized).not.toContain("postData");
    void TS_HINT;
  });

  it("marks loadingFailed entries and ignores unsupported/unmonitored events", async () => {
    const fixture = harness();
    await fixture.manager.ensureNetworkMonitoring(PROJECT);
    fixture.manager.handleDebuggerEvent(71, "Network.requestWillBeSent", {
      requestId: "raw-f",
      request: { url: "https://example.test/f", method: "GET", headers: {} },
    });
    fixture.manager.handleDebuggerEvent(71, "Network.loadingFailed", { requestId: "raw-f", errorText: "net::ERR_ABORTED" });
    // Unsupported: ExtraInfo-style and arbitrary methods are dropped.
    fixture.manager.handleDebuggerEvent(71, "Network.requestWillBeSentExtraInfo", { requestId: "raw-x" });
    fixture.manager.handleDebuggerEvent(71, "Debugger.scriptParsed", { scriptId: "s-1" });
    // Unmonitored tab: dropped by the ownership guard.
    fixture.manager.handleDebuggerEvent(999, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "foreign-tab-marker" }],
    });
    const network = await fixture.manager.getNetwork(PROJECT);
    expect(network.entries[0]?.failed).toBe(true);
    const consoleResult = await fixture.manager.getConsole(PROJECT);
    expect(JSON.stringify(consoleResult)).not.toContain("foreign-tab-marker");
  });

  it("never forwards raw debugger events (no generic surface)", async () => {
    const fixture = harness();
    await fixture.manager.ensureConsoleMonitoring(PROJECT);
    await fixture.manager.ensureNetworkMonitoring(PROJECT);
    // Only the two fixed enable commands were sent; routing itself sends nothing.
    const methods = fixture.commands.map((c) => c.method).sort();
    expect(methods).toEqual(["Network.enable", "Runtime.enable"]);
  });
});
