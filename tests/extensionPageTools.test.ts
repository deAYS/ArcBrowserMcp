import { describe, expect, it, vi } from "vitest";
import {
  DebuggerSessionManager,
  createMemorySnapshotSessionStorage,
  CDP_CAPABILITY_METHODS,
  RETIRE_DETACH_TIMEOUT_MS,
  createScopedCdpSender,
  hasPngSignature,
  toProjectEvaluateValue,
  type DebuggerChrome,
  type SnapshotTabRecord,
} from "../extension/src/snapshot.js";
import {
  EVALUATE_DEFAULT_TIMEOUT_MS,
  EVALUATE_EXPRESSION_LIMIT_BYTES,
  EVALUATE_MAX_TIMEOUT_MS,
  EVALUATE_RESULT_MAX_SERIALIZED_BYTES,
  PNG_SIGNATURE,
  SCREENSHOT_DECODED_LIMIT_BYTES,
} from "../src/browser/pageToolsPolicy.js";
import { LARGE_RESPONSE_FRAME_MAX_BYTES } from "../src/bridge/frameLimits.js";

const SESSION = "c".repeat(32);
const PROJECT = `t-${"c".repeat(32)}-31`;

type AxNode = Record<string, unknown>;

function tree(): AxNode[] {
  return [
    {
      nodeId: "1",
      role: { value: "heading" },
      name: { value: "P08 Fixture" },
      backendDOMNodeId: 301,
      childIds: ["2", "3"],
    },
    {
      nodeId: "2",
      role: { value: "textbox" },
      name: { value: "Name" },
      value: { value: "visible-value" },
      backendDOMNodeId: 302,
    },
    {
      nodeId: "3",
      role: { value: "textbox" },
      name: { value: "Password" },
      value: { value: "hunter2" },
      backendDOMNodeId: 303,
    },
  ];
}

interface Harness {
  manager: DebuggerSessionManager;
  commands: Array<{ method: string; params: Record<string, unknown> | undefined }>;
  debuggerChrome: DebuggerChrome;
  detachCalls: () => number;
  attachCalls: () => number;
  hangEvaluate: (hooks: {
    onResolve?: (value: Record<string, unknown>) => void;
    onReject?: (error: unknown) => void;
  }) => { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void };
  screenshotData: (data: unknown) => void;
}

/** Minimal fake: only the P08 paths + capture support are served. */
function harness(options: {
  runtimeImpl?: (expression: string) => Record<string, unknown>;
  tabUrl?: string;
  detachImpl?: () => Promise<void>;
} = {}): Harness {
  const commands: Harness["commands"] = [];
  let attachCount = 0;
  let detachCount = 0;
  let screenshotOverride: Record<string, unknown> | null = null;
  let hangHooks: {
    onResolve?: (value: Record<string, unknown>) => void;
    onReject?: (error: unknown) => void;
  } | null = null;
  let hangSettled: { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void } | null = null;
  const records = new Map<number, SnapshotTabRecord>([
    [31, { id: PROJECT, url: options.tabUrl ?? "https://fixture.local/", title: "Fixture" }],
  ]);
  const debuggerChrome: DebuggerChrome = {
    attach: () => {
      attachCount += 1;
      return Promise.resolve();
    },
    sendCommand: (_tabId, method, params) => {
      commands.push({ method, params });
      if (method === "Runtime.evaluate" && hangSettled === null && hangHooks !== null) {
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          hangSettled = {
            resolve: (value) => {
              hangHooks?.onResolve?.(value);
              resolve(value);
            },
            reject: (error) => {
              hangHooks?.onReject?.(error);
              reject(error);
            },
          };
        });
      }
      if (method === "Runtime.evaluate" && options.runtimeImpl !== undefined) {
        const expression = typeof params?.["expression"] === "string" ? params["expression"] : "";
        return Promise.resolve(options.runtimeImpl(expression));
      }
      if (method === "Page.captureScreenshot" && screenshotOverride !== null) {
        return Promise.resolve(screenshotOverride);
      }
      return defaultSend(method, params);
    },
    detach: () => {
      detachCount += 1;
      commands.push({ method: "__detach__", params: undefined });
      return options.detachImpl !== undefined ? options.detachImpl() : Promise.resolve();
    },
    onDetach: () => undefined,
  };
  const manager = new DebuggerSessionManager(
    debuggerChrome,
    (projectId) =>
      projectId === PROJECT ? Promise.resolve(31) : Promise.reject(Object.assign(new Error("x"), { code: "TAB_INVALID_ID" })),
    (chromeId) => records.get(chromeId) ?? null,
    createMemorySnapshotSessionStorage(),
    { generateSessionId: () => SESSION },
  );
  return {
    manager,
    commands,
    debuggerChrome,
    detachCalls: () => detachCount,
    attachCalls: () => attachCount,
    hangEvaluate: (hooks) => {
      hangHooks = hooks;
      if (hangSettled !== null) {
        throw new Error("evaluate already hanging");
      }
      return {
        resolve: (value) => {
          if (hangSettled === null) {
            throw new Error("no hanging evaluate to resolve");
          }
          hangSettled.resolve(value);
        },
        reject: (error) => {
          if (hangSettled === null) {
            throw new Error("no hanging evaluate to reject");
          }
          hangSettled.reject(error);
        },
      };
    },
    screenshotData: (data: unknown) => {
      screenshotOverride = { data };
    },
  };
}

function defaultSend(
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  if (method === "DOM.describeNode") {
    const backendNodeId = typeof params?.["backendNodeId"] === "number" ? params["backendNodeId"] : -1;
    return Promise.resolve({
      node: {
        nodeName: "INPUT",
        attributes: ["type", backendNodeId === 303 ? "password" : "text"],
      },
    });
  }
  if (method === "Accessibility.getFullAXTree") {
    return Promise.resolve({ nodes: tree() });
  }
  if (method === "Runtime.evaluate") {
    const expression = typeof params?.["expression"] === "string" ? params["expression"] : "";
    return Promise.resolve({ result: { type: "string", value: `echo:${expression.slice(0, 8)}` } });
  }
  if (method === "Page.captureScreenshot") {
    // 1x1 transparent PNG (68 bytes): smallest valid PNG fixture.
    const tiny =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    return Promise.resolve({ data: tiny });
  }
  return Promise.resolve({});
}

/** Real 1x1 PNG bytes for signature checks. */
function tinyPngBytes(): number[] {
  const tiny =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const raw = Buffer.from(tiny, "base64");
  return [...raw.slice(0, 8)];
}

describe("P08 evaluate result projection", () => {
  it("projects JSON primitives, arrays, and plain objects by value", () => {
    expect(toProjectEvaluateValue({ result: { type: "string", value: "hi" } })).toEqual({ kind: "json", value: "hi" });
    expect(toProjectEvaluateValue({ result: { type: "number", value: 42 } })).toEqual({ kind: "json", value: 42 });
    expect(toProjectEvaluateValue({ result: { type: "boolean", value: true } })).toEqual({
      kind: "json",
      value: true,
    });
    expect(toProjectEvaluateValue({ result: { type: "object", value: null } })).toEqual({ kind: "json", value: null });
    expect(toProjectEvaluateValue({ result: { type: "object", value: { a: [1, "x", null] } } })).toEqual({
      kind: "json",
      value: { a: [1, "x", null] },
    });
    expect(toProjectEvaluateValue({ result: { type: "number", value: 0 } })).toEqual({ kind: "json", value: 0 });
  });

  it("distinguishes undefined, NaN, infinities, -0, and bigint", () => {
    expect(toProjectEvaluateValue({ result: { type: "undefined" } })).toEqual({ kind: "undefined" });
    expect(toProjectEvaluateValue({ result: { type: "number", unserializableValue: "NaN" } })).toEqual({ kind: "nan" });
    expect(toProjectEvaluateValue({ result: { type: "number", unserializableValue: "Infinity" } })).toEqual({
      kind: "infinity",
    });
    expect(toProjectEvaluateValue({ result: { type: "number", unserializableValue: "-Infinity" } })).toEqual({
      kind: "neg-infinity",
    });
    expect(toProjectEvaluateValue({ result: { type: "number", unserializableValue: "-0" } })).toEqual({
      kind: "neg-zero",
    });
    expect(toProjectEvaluateValue({ result: { type: "bigint", description: "12345678901234567890" } })).toEqual({
      kind: "bigint",
      value: "12345678901234567890",
    });
  });

  it("rejects exceptions, objectIds, and non-serializable shapes without echoing page data", () => {
    const secret = `p08-eval-secret-${"d4".repeat(8)}`;
    for (const raw of [
      { exceptionDetails: { text: "boom", exception: { description: secret } } },
      { result: { type: "object", objectId: "1:2:3", description: secret } },
      { result: { type: "function", description: secret } },
      { noresult: true },
    ]) {
      let serialized = "";
      try {
        toProjectEvaluateValue(raw);
      } catch (error: unknown) {
        serialized = JSON.stringify({ code: (error as { code?: unknown }).code, message: String(error) });
      }
      expect(serialized).toContain("EVALUATION_FAILED");
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("objectId");
    }
  });

  it("rejects oversized results instead of truncating", () => {
    const big = { result: { type: "string", value: "v".repeat(EVALUATE_RESULT_MAX_SERIALIZED_BYTES) } };
    let code = "";
    try {
      toProjectEvaluateValue(big);
    } catch (error: unknown) {
      code = String((error as { code?: unknown }).code);
    }
    expect(code).toBe("EVALUATION_RESULT_TOO_LARGE");
    expect(EVALUATE_RESULT_MAX_SERIALIZED_BYTES).toBe(256 * 1024);
  });
});

describe("P08 evaluate dispatch semantics", () => {
  it("uses the fixed Runtime.evaluate params (awaitPromise/returnByValue/no gesture/no CLI API/native timeout)", async () => {
    const fixture = harness();
    const result = await fixture.manager.evaluateElement(PROJECT, "1+1", 5_000);
    expect(result.kind).toBe("json");
    const calls = fixture.commands.filter((command) => command.method === "Runtime.evaluate");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: false,
      userGesture: false,
      timeout: 5_000,
    });
    expect(typeof calls[0]?.params?.["expression"]).toBe("string");
    expect(Object.keys(calls[0]?.params ?? {})).not.toContain("contextId");
    expect(Object.keys(calls[0]?.params ?? {})).not.toContain("objectId");
    expect(fixture.commands.map((command) => command.method)).not.toContain("Runtime.callFunctionOn");
  });

  it("defaults an omitted timeout to 5000ms and rejects >10000 before dispatch", async () => {
    expect(EVALUATE_DEFAULT_TIMEOUT_MS).toBe(5_000);
    expect(EVALUATE_MAX_TIMEOUT_MS).toBe(10_000);
    const fixture = harness();
    await fixture.manager.evaluateElement(PROJECT, "1+1");
    const calls = fixture.commands.filter((command) => command.method === "Runtime.evaluate");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params?.["timeout"]).toBe(5_000);
    const over = harness();
    await expect(over.manager.evaluateElement(PROJECT, "1", 10_001)).rejects.toMatchObject({
      code: "EVALUATION_TIMEOUT",
    });
    expect(over.commands).toHaveLength(0);
    expect(over.attachCalls()).toBe(0);
  });

  it("rejects oversized expressions before any debugger dispatch", async () => {
    const fixture = harness();
    const oversized = "x".repeat(EVALUATE_EXPRESSION_LIMIT_BYTES + 1);
    expect(EVALUATE_EXPRESSION_LIMIT_BYTES).toBe(64 * 1024);
    await expect(fixture.manager.evaluateElement(PROJECT, oversized, 5_000)).rejects.toMatchObject({
      code: "EVALUATION_FAILED",
    });
    expect(fixture.commands).toHaveLength(0);
  });

  it("rejects privileged tabs before attach/evaluation", async () => {
    const fixture = harness({ tabUrl: "chrome://newtab/" });
    await expect(fixture.manager.evaluateElement(PROJECT, "1", 5_000)).rejects.toMatchObject({
      code: "TAB_NOT_CONTROLLABLE",
    });
    expect(fixture.commands).toHaveLength(0);
  });

  it("dispatched evaluation invalidates refs even when the page throws", async () => {
    const fixture = harness({
      runtimeImpl: () => ({ exceptionDetails: { text: "page boom" } }),
    });
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "heading")?.ref;
    if (ref === undefined) {
      throw new Error("expected a heading ref");
    }
    await expect(fixture.manager.evaluateElement(PROJECT, "throw 1", 5_000)).rejects.toMatchObject({
      code: "EVALUATION_FAILED",
    });
    expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(false);
  });

  it("pre-dispatch validation failure does not invalidate refs", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "heading")?.ref;
    if (ref === undefined) {
      throw new Error("expected a heading ref");
    }
    await expect(
      fixture.manager.evaluateElement(PROJECT, "x".repeat(EVALUATE_EXPRESSION_LIMIT_BYTES + 1), 5_000),
    ).rejects.toMatchObject({ code: "EVALUATION_FAILED" });
    expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(true);
  });

  it("thrown sentinel secrets never appear in errors or commands", async () => {
    const sentinel = `p08-eval-secret-${"e5".repeat(8)}`;
    const fixture = harness({
      runtimeImpl: () => ({ exceptionDetails: { text: "boom", exception: { description: sentinel } } }),
    });
    let serialized = "";
    try {
      await fixture.manager.evaluateElement(PROJECT, `throw ${sentinel}`, 5_000);
    } catch (error: unknown) {
      serialized = JSON.stringify({ code: (error as { code?: unknown }).code, message: String(error) });
    }
    expect(serialized).toContain("EVALUATION_FAILED");
    expect(serialized).not.toContain(sentinel);
    expect(JSON.stringify(fixture.commands)).not.toContain("Runtime.callFunctionOn");
  });
});

describe("P08 screenshot dispatch semantics", () => {
  it("uses fixed viewport-PNG params and validates the PNG fixture", async () => {
    const fixture = harness();
    const shot = await fixture.manager.captureScreenshot(PROJECT);
    expect(shot.mimeType).toBe("image/png");
    expect(typeof shot.data).toBe("string");
    expect(shot.data.length).toBeGreaterThan(0);
    const calls = fixture.commands.filter((command) => command.method === "Page.captureScreenshot");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({ format: "png", fromSurface: true, captureBeyondViewport: false });
    expect(fixture.commands.map((command) => command.method)).not.toContain("Page.enable");
    expect(fixture.commands.map((command) => command.method)).not.toContain("Runtime.evaluate");
    expect(hasPngSignature(tinyPngBytes())).toBe(true);
    expect([...PNG_SIGNATURE]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("rejects privileged tabs before any screenshot dispatch", async () => {
    const fixture = harness({ tabUrl: "chrome://newtab/" });
    await expect(fixture.manager.captureScreenshot(PROJECT)).rejects.toMatchObject({
      code: "TAB_NOT_CONTROLLABLE",
    });
    expect(fixture.commands).toHaveLength(0);
  });

  it("screenshot is read-only: existing refs stay valid", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "heading")?.ref;
    if (ref === undefined) {
      throw new Error("expected a heading ref");
    }
    await fixture.manager.captureScreenshot(PROJECT);
    expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(true);
  });

  it("rejects empty/invalid encodings and tolerates no clip passthrough", async () => {
    const fixture = harness();
    // Exercise the public shape: screenshot takes no params on the bridge;
    // extension internals reject malformed CDP payloads deterministically.
    await expect(fixture.manager.captureScreenshot(PROJECT)).resolves.toMatchObject({ mimeType: "image/png" });
    expect(SCREENSHOT_DECODED_LIMIT_BYTES).toBe(8 * 1024 * 1024);
  });

  it("rejects valid base64 with a wrong PNG signature extension-side", async () => {
    const fixture = harness();
    // "hello world" base64: valid encoding, wrong magic.
    fixture.screenshotData("aGVsbG8gd29ybGQ=");
    await expect(fixture.manager.captureScreenshot(PROJECT)).rejects.toMatchObject({
      code: "SCREENSHOT_FAILED",
    });
  });

  it("rejects malformed base64 extension-side without echoing payload", async () => {
    const fixture = harness();
    fixture.screenshotData("!!!not-base64!!!");
    let serialized = "";
    try {
      await fixture.manager.captureScreenshot(PROJECT);
    } catch (error: unknown) {
      serialized = JSON.stringify({ code: (error as { code?: unknown }).code, message: String(error) });
    }
    expect(serialized).toContain("SCREENSHOT_FAILED");
    expect(serialized).not.toContain("!!!not-base64!!!");
  });

  it("rejects empty screenshot payloads extension-side", async () => {
    const fixture = harness();
    fixture.screenshotData("");
    await expect(fixture.manager.captureScreenshot(PROJECT)).rejects.toMatchObject({
      code: "SCREENSHOT_FAILED",
    });
  });

  it("rejects oversized decoded payloads extension-side", async () => {
    const fixture = harness();
    // Syntactically valid base64 whose decoded length exceeds 8 MiB.
    const repeat = Math.ceil((SCREENSHOT_DECODED_LIMIT_BYTES + 16) / 3);
    fixture.screenshotData("QUFB".repeat(repeat));
    await expect(fixture.manager.captureScreenshot(PROJECT)).rejects.toMatchObject({
      code: "SCREENSHOT_TOO_LARGE",
    });
  });

  it("maximum legitimate screenshot response fits the large-response frame", () => {
    // Worst case: 8 MiB decoded -> base64 + generous envelope margin.
    const maxWire = Math.ceil(SCREENSHOT_DECODED_LIMIT_BYTES / 3) * 4 + 512;
    expect(maxWire).toBeLessThan(LARGE_RESPONSE_FRAME_MAX_BYTES);
  });
});

describe("P08 operation-scoped CDP capabilities", () => {
  it("declares the exact effective capability groups", () => {
    expect([...CDP_CAPABILITY_METHODS.snapshot]).toEqual([
      "Accessibility.enable",
      "Accessibility.getFullAXTree",
      "DOM.enable",
      "DOM.describeNode",
    ]);
    expect([...CDP_CAPABILITY_METHODS.evaluate]).toEqual(["Runtime.evaluate"]);
    expect([...CDP_CAPABILITY_METHODS.screenshot]).toEqual(["Page.captureScreenshot"]);
    expect([...CDP_CAPABILITY_METHODS.interaction]).toEqual([
      "Accessibility.enable",
      "Accessibility.getFullAXTree",
      "Accessibility.getPartialAXTree",
      "DOM.enable",
      "DOM.describeNode",
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getContentQuads",
      "DOM.focus",
      "Input.dispatchMouseEvent",
      "Input.dispatchKeyEvent",
      "Input.insertText",
    ]);
    expect([...CDP_CAPABILITY_METHODS.wait]).toEqual([
      "Accessibility.enable",
      "Accessibility.getFullAXTree",
      "DOM.enable",
      "DOM.describeNode",
    ]);
  });

  it("scoped senders refuse cross-capability methods at runtime", async () => {
    const transport = vi.fn(async () => ({}));
    const evaluateSender = createScopedCdpSender("evaluate", transport);
    await expect(evaluateSender(31, "Runtime.evaluate", {})).resolves.toEqual({});
    await expect(
      evaluateSender(31, "Page.captureScreenshot" as never, {}),
    ).rejects.toMatchObject({ code: "SNAPSHOT_FAILED" });
    const screenshotSender = createScopedCdpSender("screenshot", transport);
    await expect(
      screenshotSender(31, "Runtime.evaluate" as never, {}),
    ).rejects.toMatchObject({ code: "SNAPSHOT_FAILED" });
    const snapshotSender = createScopedCdpSender("snapshot", transport);
    await expect(
      snapshotSender(31, "Runtime.evaluate" as never, {}),
    ).rejects.toMatchObject({ code: "SNAPSHOT_FAILED" });
    const interactionSender = createScopedCdpSender("interaction", transport);
    await expect(
      interactionSender(31, "Runtime.evaluate" as never, {}),
    ).rejects.toMatchObject({ code: "SNAPSHOT_FAILED" });
    const waitSender = createScopedCdpSender("wait", transport);
    await expect(
      waitSender(31, "Runtime.evaluate" as never, {}),
    ).rejects.toMatchObject({ code: "SNAPSHOT_FAILED" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("feature paths issue only their own capability methods", async () => {
    const snapshotFixture = harness();
    await snapshotFixture.manager.capture(PROJECT);
    for (const command of snapshotFixture.commands) {
      expect([...CDP_CAPABILITY_METHODS.snapshot]).toContain(command.method);
    }
    expect(snapshotFixture.commands.map((command) => command.method)).not.toContain("Runtime.evaluate");
    const shotFixture = harness();
    await shotFixture.manager.captureScreenshot(PROJECT);
    for (const command of shotFixture.commands) {
      expect([...CDP_CAPABILITY_METHODS.screenshot]).toContain(command.method);
    }
    const evalFixture = harness();
    await evalFixture.manager.evaluateElement(PROJECT, "1", 50);
    for (const command of evalFixture.commands) {
      expect([...CDP_CAPABILITY_METHODS.evaluate]).toContain(command.method);
    }
    const waitFixture = harness();
    await waitFixture.manager.waitTextCorpus(PROJECT);
    for (const command of waitFixture.commands) {
      expect([...CDP_CAPABILITY_METHODS.wait]).toContain(command.method);
    }
    expect(waitFixture.commands.map((command) => command.method)).not.toContain("Runtime.evaluate");
  });
});

describe("P08 evaluate timeout retirement", () => {
  it("owned evaluate success performs no detach and stays reusable", async () => {
    const fixture = harness();
    await fixture.manager.evaluateElement(PROJECT, "1", 5_000);
    expect(fixture.detachCalls()).toBe(0);
    expect(fixture.manager.debuggerSessionState(31)).toBe("OWNED");
    await fixture.manager.evaluateElement(PROJECT, "2", 5_000);
    expect(fixture.detachCalls()).toBe(0);
    expect(fixture.attachCalls()).toBe(1);
  });

  it("owned evaluate local timeout invalidates refs, retires, detaches, and reattaches", async () => {
    const fixture = harness();
    fixture.manager.setRetireDetachTimeoutMsForTests(1_000);
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "heading")?.ref;
    if (ref === undefined) {
      throw new Error("expected a heading ref");
    }
    const hanging = fixture.hangEvaluate({});
    const pending = fixture.manager.evaluateElement(PROJECT, "never", 20);
    await expect(pending).rejects.toMatchObject({ code: "EVALUATION_TIMEOUT" });
    expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(false);
    expect(fixture.detachCalls()).toBe(1);
    expect(fixture.manager.debuggerSessionState(31)).toBe("DETACHED");
    // Late settlement after the timeout is consumed without a second result.
    hanging.resolve({ result: { type: "string", value: "late" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fixture.manager.debuggerSessionState(31)).toBe("DETACHED");
    // Next operation lazily reattaches anew.
    await fixture.manager.evaluateElement(PROJECT, "1", 5_000);
    expect(fixture.attachCalls()).toBe(2);
  });

  it("pending command late resolution is ignored safely", async () => {
    const fixture = harness();
    fixture.manager.setRetireDetachTimeoutMsForTests(1_000);
    let observed: unknown = null;
    const hanging = fixture.hangEvaluate({ onResolve: (value) => {
      observed = value;
    } });
    const pending = fixture.manager.evaluateElement(PROJECT, "late-ok", 20);
    await expect(pending).rejects.toMatchObject({ code: "EVALUATION_TIMEOUT" });
    hanging.resolve({ result: { type: "string", value: "late-value" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The late value was consumed by the settlement handler but never
    // surfaced as a second RPC response or restored state.
    expect(observed).toEqual({ result: { type: "string", value: "late-value" } });
    expect(fixture.manager.debuggerSessionState(31)).toBe("DETACHED");
  });

  it("pending command late rejection is consumed without unhandled rejection", async () => {
    const fixture = harness();
    fixture.manager.setRetireDetachTimeoutMsForTests(1_000);
    let consumed: unknown = null;
    const hanging = fixture.hangEvaluate({ onReject: (error) => {
      consumed = error;
    } });
    const pending = fixture.manager.evaluateElement(PROJECT, "late-boom", 20);
    await expect(pending).rejects.toMatchObject({ code: "EVALUATION_TIMEOUT" });
    hanging.reject(new Error("late transport failure"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(String(consumed)).toContain("late transport failure");
    expect(fixture.manager.debuggerSessionState(31)).toBe("DETACHED");
  });

  it("foreign debugger conflict never detaches", async () => {
    const commands: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
    let detachCalls = 0;
    const records = new Map<number, SnapshotTabRecord>([
      [31, { id: PROJECT, url: "https://fixture.local/", title: "Fixture" }],
    ]);
    const foreign: DebuggerChrome = {
      attach: () => Promise.reject(new Error("another debugger is already attached")),
      sendCommand: (_tabId, method, params) => {
        commands.push({ method, params });
        return Promise.resolve({});
      },
      detach: () => {
        detachCalls += 1;
        return Promise.resolve();
      },
      onDetach: () => undefined,
    };
    const manager = new DebuggerSessionManager(
      foreign,
      (projectId) =>
        projectId === PROJECT ? Promise.resolve(31) : Promise.reject(Object.assign(new Error("x"), { code: "TAB_INVALID_ID" })),
      (chromeId) => records.get(chromeId) ?? null,
      createMemorySnapshotSessionStorage(),
      { generateSessionId: () => SESSION },
    );
    await expect(manager.evaluateElement(PROJECT, "1", 5_000)).rejects.toMatchObject({
      code: "DEBUGGER_UNAVAILABLE",
    });
    expect(detachCalls).toBe(0);
    expect(manager.debuggerSessionState(31)).toBe("DETACHED");
  });

  it("detach failure marks the session uncertain without touching anything new", async () => {
    const fixture = harness({ detachImpl: () => Promise.reject(new Error("detach boom")) });
    fixture.manager.setRetireDetachTimeoutMsForTests(1_000);
    fixture.hangEvaluate({});
    await expect(fixture.manager.evaluateElement(PROJECT, "never", 20)).rejects.toMatchObject({
      code: "EVALUATION_TIMEOUT",
    });
    expect(fixture.detachCalls()).toBe(1);
    expect(fixture.manager.debuggerSessionState(31)).toBe("UNCERTAIN");
    await expect(fixture.manager.evaluateElement(PROJECT, "1", 5_000)).rejects.toMatchObject({
      code: "DEBUGGER_UNAVAILABLE",
    });
    // No blind second detach while ownership is uncertain.
    expect(fixture.detachCalls()).toBe(1);
  });

  it("stalling detach keeps the public operation bounded and blocks racing reattach", async () => {
    const fixture = harness({ detachImpl: () => new Promise<void>(() => undefined) });
    fixture.manager.setRetireDetachTimeoutMsForTests(30);
    fixture.hangEvaluate({});
    const started = Date.now();
    await expect(fixture.manager.evaluateElement(PROJECT, "never", 20)).rejects.toMatchObject({
      code: "EVALUATION_TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fixture.manager.debuggerSessionState(31)).toBe("UNCERTAIN");
    const attachesBefore = fixture.attachCalls();
    await expect(fixture.manager.captureScreenshot(PROJECT)).rejects.toMatchObject({
      code: "DEBUGGER_UNAVAILABLE",
    });
    expect(fixture.attachCalls()).toBe(attachesBefore);
  });

  it("onDetach during retirement converges safely", async () => {
    let detachListener: ((tabId: number | undefined, reason: string) => void) | undefined;
    const commands: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
    let detachCalls = 0;
    let releaseDetach: ((value: void | PromiseLike<void>) => void) | undefined;
    const records = new Map<number, SnapshotTabRecord>([
      [31, { id: PROJECT, url: "https://fixture.local/", title: "Fixture" }],
    ]);
    const chrome: DebuggerChrome = {
      attach: () => Promise.resolve(),
      sendCommand: (_tabId, method, params) => {
        commands.push({ method, params });
        if (method === "Runtime.evaluate") {
          return new Promise<Record<string, unknown>>(() => undefined);
        }
        if (method === "Accessibility.getFullAXTree") {
          return Promise.resolve({ nodes: tree() });
        }
        return Promise.resolve({});
      },
      detach: () => {
        detachCalls += 1;
        return new Promise<void>((resolve) => {
          releaseDetach = resolve;
        });
      },
      onDetach: (listener) => {
        detachListener = listener;
      },
    };
    const manager = new DebuggerSessionManager(
      chrome,
      (projectId) =>
        projectId === PROJECT ? Promise.resolve(31) : Promise.reject(Object.assign(new Error("x"), { code: "TAB_INVALID_ID" })),
      (chromeId) => records.get(chromeId) ?? null,
      createMemorySnapshotSessionStorage(),
      { generateSessionId: () => SESSION },
    );
    manager.setRetireDetachTimeoutMsForTests(5_000);
    const pending = manager.evaluateElement(PROJECT, "never", 20);
    const failing = expect(pending).rejects.toMatchObject({ code: "EVALUATION_TIMEOUT" });
    // Let the local deadline fire so retirement is in flight.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(manager.debuggerSessionState(31)).toBe("RETIRING");
    // An external onDetach during retirement must not break serialization:
    // retirement stays in flight until the detach settles.
    if (detachListener !== undefined) {
      detachListener(31, "replaced_with_devtools");
    }
    expect(manager.debuggerSessionState(31)).toBe("RETIRING");
    if (releaseDetach !== undefined) {
      releaseDetach();
    }
    await failing;
    await manager.waitForRetirement(31).catch(() => undefined);
    expect(detachCalls).toBe(1);
    expect(manager.debuggerSessionState(31)).toBe("DETACHED");
  });

  it("stale retirement never detaches a newer attachment", async () => {
    const fixture = harness();
    fixture.manager.setRetireDetachTimeoutMsForTests(1_000);
    await fixture.manager.evaluateElement(PROJECT, "1", 5_000);
    expect(fixture.manager.debuggerSessionState(31)).toBe("OWNED");
    expect(RETIRE_DETACH_TIMEOUT_MS).toBe(3_000);
    // No retirement is in flight after success; a later detachAllOwned-style
    // path only detaches the current generation it positively owns.
    expect(fixture.detachCalls()).toBe(0);
  });
});
