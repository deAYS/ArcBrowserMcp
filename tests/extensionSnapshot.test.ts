import { describe, expect, it } from "vitest";
import {
  DEBUG_PROTOCOL_VERSION,
  DebuggerSessionManager,
  createMemorySnapshotSessionStorage,
  generateSnapshotSessionId,
  isSnapshotableSourceUrl,
  type DebuggerChrome,
  type SnapshotTabRecord,
} from "../extension/src/snapshot.js";

const SESSION = "a".repeat(32);
const SESSION_ALT = "b".repeat(32);
const PROJECT = `t-${"a".repeat(32)}-11`;
const OTHER_PROJECT = `t-${"a".repeat(32)}-22`;

function axTree(overrides: Record<string, unknown> = {}): Record<string, unknown>[] {
  return [
    {
      nodeId: "1",
      role: { value: "heading" },
      name: { value: "Example Domain" },
      childIds: ["2"],
      ...overrides,
    },
    { nodeId: "2", role: { value: "link" }, name: { value: "Learn more" } },
  ];
}

interface Harness {
  manager: DebuggerSessionManager;
  commands: Array<{ method: string; params: Record<string, unknown> | undefined }>;
  attaches: number[];
  detaches: number[];
  failures: Map<string, Error>;
  records: Map<number, SnapshotTabRecord>;
  detachListeners: Array<(tabId: number | undefined, reason: string) => void>;
}

function harness(options: {
  attachMessage?: string;
  commandMessage?: string;
  axNodes?: Record<string, unknown>[];
  describe?: Record<string, unknown> | ((backendNodeId: number) => Record<string, unknown>);
  describeFailures?: Set<number>;
  domEnableMessage?: string;
  sessionId?: string;
} = {}): Harness {
  const commands: Harness["commands"] = [];
  const attaches: number[] = [];
  const detaches: number[] = [];
  const failures = new Map<string, Error>();
  const records = new Map<number, SnapshotTabRecord>([
    [11, { id: PROJECT, url: "https://example.com/", title: "Example Domain" }],
  ]);
  const detachListeners: Harness["detachListeners"] = [];
  const debuggerChrome: DebuggerChrome = {
    attach: (tabId) => {
      attaches.push(tabId);
      if (options.attachMessage !== undefined) {
        return Promise.reject(new Error(options.attachMessage));
      }
      return Promise.resolve();
    },
    sendCommand: (tabId, method, params) => {
      void tabId;
      commands.push({ method, params });
      const failure = failures.get(method);
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      if (method === "DOM.enable" && options.domEnableMessage !== undefined) {
        return Promise.reject(new Error(options.domEnableMessage));
      }
      if (method === "Accessibility.getFullAXTree") {
        if (options.commandMessage !== undefined) {
          return Promise.reject(new Error(options.commandMessage));
        }
        return Promise.resolve({ nodes: options.axNodes ?? axTree() });
      }
      if (method === "DOM.describeNode") {
        const backendNodeId = typeof params?.["backendNodeId"] === "number" ? params["backendNodeId"] : -1;
        if (options.describeFailures?.has(backendNodeId) === true) {
          return Promise.reject(new Error("describe failed"));
        }
        if (typeof options.describe === "function") {
          return Promise.resolve(options.describe(backendNodeId));
        }
        return Promise.resolve(options.describe ?? { node: { nodeName: "A", attributes: [] } });
      }
      return Promise.resolve({});
    },
    detach: (tabId) => {
      detaches.push(tabId);
      return Promise.resolve();
    },
    onDetach: (listener) => {
      detachListeners.push(listener);
    },
  };
  const manager = new DebuggerSessionManager(
    debuggerChrome,
    (projectId) => {
      if (projectId === PROJECT) {
        return Promise.resolve(11);
      }
      if (projectId === OTHER_PROJECT) {
        return Promise.resolve(22);
      }
      return Promise.reject(Object.assign(new Error("unknown tab"), { code: "TAB_NOT_FOUND" }));
    },
    (chromeId) => records.get(chromeId) ?? null,
    createMemorySnapshotSessionStorage(),
    { generateSessionId: () => options.sessionId ?? SESSION },
  );
  return { manager, commands, attaches, detaches, failures, records, detachListeners };
}

describe("snapshot source gating", () => {
  it("treats only http/https as controllable (about:blank rejected)", () => {
    expect(isSnapshotableSourceUrl("https://example.com/")).toBe(true);
    expect(isSnapshotableSourceUrl("http://localhost/")).toBe(true);
    expect(isSnapshotableSourceUrl("about:blank")).toBe(false);
    expect(isSnapshotableSourceUrl("")).toBe(false);
    expect(isSnapshotableSourceUrl("chrome://newtab/")).toBe(false);
    expect(isSnapshotableSourceUrl("arc://x")).toBe(false);
    expect(DEBUG_PROTOCOL_VERSION).toBe("1.3");
  });

  it("generates 128-bit (32-hex) session ids from crypto randomness only", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const id = generateSnapshotSessionId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(5);
    // Deterministic injection proves the 16-byte crypto path (no
    // Math.random/Date.now/PID/counter): 16 bytes -> 32 hex chars.
    const deterministic = generateSnapshotSessionId((bytes) => {
      expect(bytes.length).toBe(16);
      bytes.fill(0xab);
    });
    expect(deterministic).toBe("ab".repeat(16));
  });

  it("rejects malformed session generations", async () => {
    // generateSessionId override returning 32-bit legacy shape is rejected
    // and replaced with a valid 128-bit id (capture still succeeds).
    const legacy = harness({ sessionId: "aaaaaaaa" });
    const captured = await legacy.manager.capture(PROJECT);
    expect(captured.snapshotId).toMatch(/^s-[0-9a-f]{32}-[0-9a-z]+$/);
    const ref = captured.nodes.find((node) => node.role === "link")?.ref;
    expect(ref).toMatch(/^e-[0-9a-f]{32}-[0-9a-z]+-[0-9a-z]+$/);
    expect(ref).not.toContain("e-aaaaaaaa-");
  });

  it("rejects privileged tabs before attaching", async () => {
    const fixture = harness();
    fixture.records.set(11, { id: PROJECT, url: "chrome://newtab/", title: "" });
    await expect(fixture.manager.capture(PROJECT)).rejects.toMatchObject({ code: "TAB_NOT_CONTROLLABLE" });
    expect(fixture.attaches).toEqual([]);
  });

  it("rejects unknown tabs without attaching", async () => {
    const fixture = harness();
    await expect(fixture.manager.capture("nope")).rejects.toMatchObject({ code: "TAB_NOT_FOUND" });
    expect(fixture.attaches).toEqual([]);
  });
});

describe("snapshot capture and refs", () => {
  it("captures semantic nodes with opaque refs and no raw ids", async () => {
    const fixture = harness();
    const first = await fixture.manager.capture(PROJECT);
    expect(first.snapshotId).toBe(`s-${SESSION}-0`);
    expect(first.tabId).toBe(PROJECT);
    expect(first.url).toBe("https://example.com/");
    expect(first.title).toBe("Example Domain");
    expect(first.nodes.some((node) => node.role === "heading" && node.name === "Example Domain")).toBe(true);
    const link = first.nodes.find((node) => node.role === "link");
    expect(link?.name).toBe("Learn more");
    expect(link?.ref).toMatch(/^e-[0-9a-f]{32}-[0-9a-z]+-[0-9a-z]+$/);
    expect(JSON.stringify(first)).not.toContain("backendNodeId");
    expect(JSON.stringify(first)).not.toContain("nodeId");
    expect(JSON.stringify(first)).not.toContain("objectId");
    expect(fixture.commands.map((command) => command.method)).toEqual([
      "Accessibility.enable",
      "Accessibility.getFullAXTree",
    ]);
    // Lazy persistent attachment: attached once, reused on second capture.
    const second = await fixture.manager.capture(PROJECT);
    expect(second.snapshotId).toBe(`s-${SESSION}-1`);
    expect(fixture.attaches).toEqual([11]);
  });

  it("uses only allowlisted CDP methods and never Runtime.evaluate", async () => {
    const fixture = harness();
    await fixture.manager.capture(PROJECT);
    for (const command of fixture.commands) {
      expect(["Accessibility.enable", "Accessibility.getFullAXTree", "DOM.enable", "DOM.describeNode"]).toContain(
        command.method,
      );
      expect(command.method).not.toBe("Runtime.evaluate");
      expect(command.method).not.toContain("Runtime");
    }
  });

  it("creates opaque refs scoped per snapshot (same AX node, distinct refs)", async () => {
    const fixture = harness();
    const first = await fixture.manager.capture(PROJECT);
    const second = await fixture.manager.capture(PROJECT);
    const firstLink = first.nodes.find((node) => node.role === "link")?.ref;
    const secondLink = second.nodes.find((node) => node.role === "link")?.ref;
    expect(firstLink).toBeDefined();
    expect(secondLink).toBeDefined();
    expect(firstLink).not.toBe(secondLink);
  });

  it("latest-snapshot-only: older refs fail closed after a newer snapshot", async () => {
    const fixture = harness();
    const first = await fixture.manager.capture(PROJECT);
    const oldRef = first.nodes.find((node) => node.role === "link")?.ref;
    expect(oldRef).toBeDefined();
    if (oldRef === undefined) {
      throw new Error("expected a link ref");
    }
    expect(fixture.manager.isRefValid(PROJECT, oldRef)).toBe(true);
    await fixture.manager.capture(PROJECT);
    expect(fixture.manager.isRefValid(PROJECT, oldRef)).toBe(false);
    expect(() => fixture.manager.resolveRef(PROJECT, oldRef)).toThrow();
  });

  it("rejects malformed refs and foreign tab ids", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "link")?.ref;
    expect(ref).toBeDefined();
    if (ref === undefined) {
      throw new Error("expected a link ref");
    }
    expect(fixture.manager.isRefValid(PROJECT, "nope")).toBe(false);
    expect(fixture.manager.isRefValid(OTHER_PROJECT, ref)).toBe(false);
    expect(() => fixture.manager.resolveRef(PROJECT, "nope")).toThrow();
    expect(() => fixture.manager.resolveRef(OTHER_PROJECT, ref)).toThrow();
  });

  it("navigation invalidates refs; selected-tab change never retargets", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "link")?.ref;
    expect(ref).toBeDefined();
    if (ref === undefined) {
      throw new Error("expected a link ref");
    }
    fixture.manager.handleTabUpdated(11, { url: "https://example.com/other" });
    expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(false);
    fixture.manager.invalidateTabByProject(PROJECT);
    const fresh = await fixture.manager.capture(PROJECT);
    const freshRef = fresh.nodes.find((node) => node.role === "link")?.ref;
    expect(freshRef).toBeDefined();
    if (freshRef === undefined) {
      throw new Error("expected a fresh link ref");
    }
    // A different project tab id can never resolve this tab's ref.
    expect(() => fixture.manager.resolveRef(OTHER_PROJECT, freshRef)).toThrow();
  });

  it("tab close invalidates refs and drops ownership", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "link")?.ref;
    expect(ref).toBeDefined();
    expect(fixture.manager.isOwned(11)).toBe(true);
    fixture.manager.handleTabRemoved(11);
    expect(fixture.manager.isOwned(11)).toBe(false);
    if (ref !== undefined) {
      expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(false);
    }
  });

  it("worker-session generation prevents ref collision after restart", async () => {
    const first = harness({ sessionId: "1".repeat(32) });
    const captured = await first.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "link")?.ref;
    expect(ref).toContain(`e-${"1".repeat(32)}-`);
    const second = harness({ sessionId: "2".repeat(32) });
    const recaptured = await second.manager.capture(PROJECT);
    const newRef = recaptured.nodes.find((node) => node.role === "link")?.ref;
    expect(newRef).toContain(`e-${"2".repeat(32)}-`);
    expect(newRef).not.toBe(ref);
    // The restarted session never honors the old epoch's ref.
    expect(second.manager.isRefValid(PROJECT, ref ?? `e-${"1".repeat(32)}-0-1`)).toBe(false);
  });

  it("same worker session behaves normally; new session is a different namespace", async () => {
    const fixture = harness({ sessionId: SESSION });
    const first = await fixture.manager.capture(PROJECT);
    const second = await fixture.manager.capture(PROJECT);
    // Same session: snapshot counter advances, session prefix stable.
    expect(first.snapshotId).toBe(`s-${SESSION}-0`);
    expect(second.snapshotId).toBe(`s-${SESSION}-1`);
    expect(first.nodes.find((n) => n.role === "link")?.ref).toContain(`e-${SESSION}-`);
    // New session: different namespace entirely.
    const other = harness({ sessionId: SESSION_ALT });
    const third = await other.manager.capture(PROJECT);
    expect(third.snapshotId).toBe(`s-${SESSION_ALT}-0`);
    expect(third.nodes.find((n) => n.role === "link")?.ref).toContain(`e-${SESSION_ALT}-`);
  });

  it("old ref cannot resolve against identical internal node ids in a new session", async () => {
    const first = harness({ sessionId: SESSION });
    const captured = await first.manager.capture(PROJECT);
    const oldRef = captured.nodes.find((node) => node.role === "link")?.ref;
    if (oldRef === undefined) {
      throw new Error("expected a link ref");
    }
    const second = harness({ sessionId: SESSION_ALT, axNodes: axTree() });
    await second.manager.capture(PROJECT);
    // Identical AX node ids ("1","2") in the new session: old ref still dead.
    expect(second.manager.isRefValid(PROJECT, oldRef)).toBe(false);
    expect(() => second.manager.resolveRef(PROJECT, oldRef)).toThrow();
  });

  it("reload/navigation invalidation clears refs explicitly", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "link")?.ref;
    expect(ref).toBeDefined();
    fixture.manager.invalidateTabByProject(PROJECT);
    if (ref !== undefined) {
      expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(false);
    }
  });

  it("external same-URL reload invalidates refs via loading transition", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "link")?.ref;
    if (ref === undefined) {
      throw new Error("expected a link ref");
    }
    // Same URL, new document: status loading with the identical URL.
    fixture.manager.handleTabUpdated(11, { status: "loading", url: "https://example.com/" });
    expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(false);
    expect(() => fixture.manager.resolveRef(PROJECT, ref)).toThrow();
  });

  it("title-only update and activation do not invalidate; loading without url still does", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "link")?.ref;
    if (ref === undefined) {
      throw new Error("expected a link ref");
    }
    // Title-only: neither status loading nor url change.
    fixture.manager.handleTabUpdated(11, { status: "complete" });
    expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(true);
    fixture.manager.handleTabUpdated(11, {});
    expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(true);
    // Loading with no url (reload commit before URL known): still stale.
    fixture.manager.handleTabUpdated(11, { status: "loading" });
    expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(false);
  });

  it("MCP reload/navigate, tab close, and debugger detach still invalidate", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "link")?.ref;
    if (ref === undefined) {
      throw new Error("expected a link ref");
    }
    fixture.manager.invalidateTabByProject(PROJECT); // MCP browser_reload / browser_navigate path
    expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(false);
    const fresh = await fixture.manager.capture(PROJECT);
    const freshRef = fresh.nodes.find((node) => node.role === "link")?.ref;
    if (freshRef === undefined) {
      throw new Error("expected a fresh link ref");
    }
    fixture.manager.handleTabRemoved(11); // tab close path
    expect(fixture.manager.isRefValid(PROJECT, freshRef)).toBe(false);
    const newer = await fixture.manager.capture(PROJECT);
    const newerRef = newer.nodes.find((node) => node.role === "link")?.ref;
    if (newerRef === undefined) {
      throw new Error("expected a newer link ref");
    }
    fixture.manager.handleDetach(11); // debugger onDetach path
    expect(fixture.manager.isRefValid(PROJECT, newerRef)).toBe(false);
  });
});

describe("fail-closed value redaction", () => {
  function editableTree(count: number, startBackendId: number, valuePrefix = "secret"): Record<string, unknown>[] {
    const nodes: Record<string, unknown>[] = [{ nodeId: "root", role: { value: "group" }, childIds: [] as string[] }];
    const childIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = `n${String(index)}`;
      childIds.push(id);
      nodes.push({
        nodeId: id,
        role: { value: "textbox" },
        name: { value: `Field ${String(index)}` },
        value: { value: `${valuePrefix}-${String(index)}` },
        backendDOMNodeId: startBackendId + index,
      });
    }
    (nodes[0] as Record<string, unknown>)["childIds"] = childIds;
    return nodes;
  }

  it("redacts a password control beyond the 20-probe budget", async () => {
    // 25 candidate editables; the last five (incl. any password field)
    // are never probed and must fail closed.
    const axNodes = editableTree(25, 100);
    const fixture = harness({
      axNodes,
      describe: () => ({ node: { nodeName: "INPUT", attributes: ["type", "text"] } }),
    });
    const captured = await fixture.manager.capture(PROJECT);
    const probed = fixture.commands.filter((command) => command.method === "DOM.describeNode").length;
    expect(probed).toBe(20);
    const byName = new Map(captured.nodes.map((node) => [node.name, node]));
    // Probed + positively safe: retained.
    expect(byName.get("Field 0")?.value).toBe("secret-0");
    expect(byName.get("Field 19")?.value).toBe("secret-19");
    // Beyond budget: redacted even though benign-looking (password hiding here fails closed).
    for (const index of [20, 21, 22, 23, 24]) {
      expect(byName.get(`Field ${String(index)}`)?.value, `Field ${String(index)} must redact`).toBeUndefined();
    }
  });

  it("redacts known safe textbox but hides password textbox", async () => {
    const axNodes = editableTree(2, 200);
    const fixture = harness({
      axNodes,
      describe: (backendNodeId) =>
        backendNodeId === 200
          ? { node: { nodeName: "INPUT", attributes: ["type", "text"] } }
          : { node: { nodeName: "INPUT", attributes: ["type", "password"] } },
    });
    const captured = await fixture.manager.capture(PROJECT);
    const safe = captured.nodes.find((node) => node.name === "Field 0");
    const password = captured.nodes.find((node) => node.name === "Field 1");
    expect(safe?.value).toBe("secret-0");
    expect(password?.value).toBeUndefined();
  });

  it("describeNode rejection redacts the value", async () => {
    const axNodes = editableTree(1, 300);
    const fixture = harness({ axNodes, describeFailures: new Set([300]) });
    const captured = await fixture.manager.capture(PROJECT);
    expect(captured.nodes.find((node) => node.role === "textbox")?.value).toBeUndefined();
  });

  it("missing backend node redacts the value", async () => {
    const axNodes: Record<string, unknown>[] = [
      { nodeId: "1", role: { value: "textbox" }, name: { value: "Email" }, value: { value: "a@x.com" } },
    ];
    const fixture = harness({ axNodes });
    const captured = await fixture.manager.capture(PROJECT);
    expect(captured.nodes[0]?.value).toBeUndefined();
  });

  it("ambiguous editable control (unclassified combobox) redacts the value", async () => {
    const axNodes: Record<string, unknown>[] = [
      {
        nodeId: "1",
        role: { value: "combobox" },
        name: { value: "Country" },
        value: { value: "US" },
        backendDOMNodeId: 400,
      },
    ];
    // describeNode returns a select (no input type): not positively safe.
    const fixture = harness({ axNodes, describe: { node: { nodeName: "SELECT", attributes: [] } } });
    const captured = await fixture.manager.capture(PROJECT);
    expect(captured.nodes[0]?.value).toBeUndefined();
  });

  it("DOM.enable failure redacts every editable value", async () => {
    const axNodes = editableTree(2, 500);
    const fixture = harness({ axNodes, domEnableMessage: "not attached" });
    const captured = await fixture.manager.capture(PROJECT);
    for (const node of captured.nodes) {
      if (node.role === "textbox") {
        expect(node.value).toBeUndefined();
      }
    }
  });

  it("serialized payload stays under the hard cap on real captures", async () => {
    const raw: Record<string, unknown>[] = [];
    for (let index = 0; index < 1500; index += 1) {
      raw.push({
        nodeId: String(index + 1),
        role: { value: "button" },
        name: { value: `${"n".repeat(200)}"\u00e9\ud83d\ude00\\\n${String(index)}` },
        description: { value: "d".repeat(200) },
      });
    }
    const fixture = harness({ axNodes: raw });
    const captured = await fixture.manager.capture(PROJECT);
    const payloadBytes = new TextEncoder().encode(JSON.stringify(captured)).length;
    expect(payloadBytes).toBeLessThanOrEqual(256 * 1024);
    expect(captured.truncated).toBe(true);
    expect(captured.totalNodes).toBe(1500);
    expect(captured.includedNodes).toBe(captured.nodes.length);
  });
});

describe("debugger lifecycle", () => {
  it("does not steal an external debugger", async () => {
    const fixture = harness({ attachMessage: "Cannot attach: another debugger is already attached" });
    await expect(fixture.manager.capture(PROJECT)).rejects.toMatchObject({ code: "DEBUGGER_UNAVAILABLE" });
    expect(fixture.manager.isOwned(11)).toBe(false);
  });

  it("onDetach clears ownership and invalidates refs", async () => {
    const fixture = harness();
    const captured = await fixture.manager.capture(PROJECT);
    const ref = captured.nodes.find((node) => node.role === "link")?.ref;
    expect(fixture.manager.isOwned(11)).toBe(true);
    for (const listener of fixture.detachListeners) {
      listener(11, "replaced_with_devtools");
    }
    expect(fixture.manager.isOwned(11)).toBe(false);
    if (ref !== undefined) {
      expect(fixture.manager.isRefValid(PROJECT, ref)).toBe(false);
    }
    // Future snapshots may reattach normally.
    const recaptured = await fixture.manager.capture(PROJECT);
    expect(recaptured.snapshotId).not.toBe(captured.snapshotId);
    expect(fixture.manager.isOwned(11)).toBe(true);
  });

  it("does not attach unrelated tabs", async () => {
    const fixture = harness();
    await fixture.manager.capture(PROJECT);
    expect(fixture.attaches).toEqual([11]);
  });

  it("stale attach state after worker restart never detaches a foreign session", async () => {
    const fixture = harness();
    // Fresh manager owns nothing; detachAllOwned must not call detach.
    await fixture.manager.detachAllOwned();
    expect(fixture.detaches).toEqual([]);
    await fixture.manager.capture(PROJECT);
    await fixture.manager.detachAllOwned();
    expect(fixture.detaches).toEqual([11]);
  });
});
