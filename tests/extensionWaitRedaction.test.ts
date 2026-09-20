import { describe, expect, it } from "vitest";
import {
  DebuggerSessionManager,
  createMemorySnapshotSessionStorage,
  type DebuggerChrome,
  type SnapshotTabRecord,
} from "../extension/src/snapshot.js";

const SESSION = "d".repeat(32);
const PROJECT = `t-${"d".repeat(32)}-51`;

const SENTINEL = `wait-secret-${"b8".repeat(8)}-must-stay-hidden`;

type AxNode = Record<string, unknown>;

function tree(): AxNode[] {
  return [
    {
      nodeId: "1",
      role: { value: "heading" },
      name: { value: "Fixture" },
      backendDOMNodeId: 501,
      childIds: ["2", "3", "4"],
    },
    {
      nodeId: "2",
      role: { value: "textbox" },
      name: { value: "Name" },
      value: { value: "public visible value" },
      backendDOMNodeId: 502,
    },
    {
      nodeId: "3",
      role: { value: "textbox" },
      name: { value: "Password" },
      // The AX tree exposes the password value; the fail-closed model must
      // still withhold it from snapshots, getText, AND wait corpora.
      value: { value: SENTINEL },
      backendDOMNodeId: 503,
    },
    {
      nodeId: "4",
      role: { value: "textbox" },
      name: { value: "Mystery" },
      // No describeNode classification for this backend id (unprobed) ->
      // uncertain -> redacted everywhere, including wait corpora.
      value: { value: `uncertain-${SENTINEL}` },
      backendDOMNodeId: 504,
    },
  ];
}

interface Harness {
  manager: DebuggerSessionManager;
  commands: Array<{ method: string; params: Record<string, unknown> | undefined }>;
}

function harness(): Harness {
  const commands: Harness["commands"] = [];
  const records = new Map<number, SnapshotTabRecord>([
    [51, { id: PROJECT, url: "https://fixture.local/", title: "Fixture" }],
  ]);
  const debuggerChrome: DebuggerChrome = {
    attach: () => Promise.resolve(),
    sendCommand: (_tabId, method, params) => {
      commands.push({ method, params });
      if (method === "DOM.describeNode") {
        const backendNodeId = typeof params?.["backendNodeId"] === "number" ? params["backendNodeId"] : -1;
        if (backendNodeId === 502) {
          return Promise.resolve({ node: { nodeName: "INPUT", attributes: ["type", "text"] } });
        }
        if (backendNodeId === 503) {
          return Promise.resolve({ node: { nodeName: "INPUT", attributes: ["type", "password"] } });
        }
        // 504: describeNode fails -> unclassified -> redacted (fail closed).
        return Promise.reject(new Error("no such node"));
      }
      if (method === "Accessibility.getFullAXTree") {
        return Promise.resolve({ nodes: tree() });
      }
      return Promise.resolve({});
    },
    detach: () => Promise.resolve(),
    onDetach: () => undefined,
  };
  const manager = new DebuggerSessionManager(
    debuggerChrome,
    (projectId) =>
      projectId === PROJECT ? Promise.resolve(51) : Promise.reject(Object.assign(new Error("x"), { code: "TAB_INVALID_ID" })),
    (chromeId) => records.get(chromeId) ?? null,
    createMemorySnapshotSessionStorage(),
    { generateSessionId: () => SESSION },
  );
  return { manager, commands };
}

describe("wait text redaction parity (sentinel regression)", () => {
  it("snapshot/getText redact the sentinel and wait corpus is unsearchable for it", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    expect(JSON.stringify(captured)).not.toContain(SENTINEL);

    const heading = captured.nodes.find((node) => node.role === "heading")?.ref;
    if (heading === undefined) {
      throw new Error("expected a heading ref");
    }
    const text = await fixture.manager.getElementText(PROJECT, heading);
    expect(text.text).not.toContain(SENTINEL);

    // The wait corpus is the exact search surface wait_for(text) uses.
    const corpus = await fixture.manager.waitTextCorpus(PROJECT);
    expect(corpus).toContain("Fixture");
    expect(corpus).toContain("public visible value");
    expect(corpus).not.toContain(SENTINEL);
  });

  it("safe values ARE searchable while password/uncertain values are not", async () => {
    const fixture = harness();
    const corpus = await fixture.manager.waitTextCorpus(PROJECT);
    // Safe textbox value (positively classified text input) is searchable.
    expect(corpus.includes("public visible value")).toBe(true);
    // Password value and uncertain/unprobed value are withheld entirely.
    expect(corpus.includes(SENTINEL)).toBe(false);
    expect(corpus.includes(`uncertain-${SENTINEL}`)).toBe(false);
    // Labels (names) remain visible; only values are withheld.
    expect(corpus).toContain("Password");
    expect(corpus).toContain("Mystery");
  });

  it("wait polling allocates no refs and invalidates nothing", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "heading")?.ref;
    if (ref === undefined) {
      throw new Error("expected a heading ref");
    }
    const before = (await fixture.manager.capture(PROJECT)).snapshotId;
    void before;
    const live = (await fixture.manager.capture(PROJECT)).nodes.find((node) => node.role === "heading")?.ref;
    if (live === undefined) {
      throw new Error("expected a live heading ref");
    }
    // waitTextCorpus must not rotate the latest snapshot: the ref captured
    // immediately before polling stays valid afterwards.
    await fixture.manager.waitTextCorpus(PROJECT);
    await fixture.manager.waitTextCorpus(PROJECT);
    expect(fixture.manager.isRefValid(PROJECT, live)).toBe(true);
    expect(fixture.commands.map((command) => command.method)).not.toContain("Runtime.evaluate");
  });

  it("waitCheck text branch cannot confirm the sentinel", async () => {
    const fixture = harness();
    const hit = await fixture.manager.waitCheck(PROJECT, { type: "text", value: "public visible value" });
    expect(hit.matched).toBe(true);
    const miss = await fixture.manager.waitCheck(PROJECT, { type: "text", value: SENTINEL });
    expect(miss.matched).toBe(false);
  });
});
