import { describe, expect, it } from "vitest";
import {
  ELEMENT_REF_PATTERN,
  SNAPSHOT_DEFAULT_MAX_NODES,
  SNAPSHOT_HARD_MAX_NODES,
  SNAPSHOT_ID_PATTERN,
  SNAPSHOT_MAX_FIELD_CHARS,
  SNAPSHOT_MAX_SERIALIZED_BYTES,
  findLeakedCdpKeys,
  isElementRefSyntax,
  isSnapshotIdSyntax,
  normalizeAxTree,
  type RawAxNode,
} from "../src/browser/snapshotSemantics.js";

const SESSION32 = "a".repeat(32);

function axNode(overrides: Partial<RawAxNode> & { nodeId: string }): RawAxNode {
  return { ...overrides };
}

function axValue(value: string): { value: string } {
  return { value };
}

function prop(name: string, value: unknown): { name: string; value: { value: unknown } } {
  return { name, value: { value } };
}

describe("snapshot normalization roles", () => {
  it("normalizes representative roles with state preservation", () => {
    const raw: RawAxNode[] = [
      axNode({ nodeId: "1", role: axValue("heading"), name: axValue("Example Domain"), properties: [prop("level", 1)], childIds: ["2", "3", "4", "5", "6", "7", "8", "9", "10", "11"] }),
      axNode({ nodeId: "2", role: axValue("StaticText"), name: axValue("This domain is for use.") }),
      axNode({ nodeId: "3", role: axValue("link"), name: axValue("Learn more") }),
      axNode({ nodeId: "4", role: axValue("button"), name: axValue("Sign in") }),
      axNode({ nodeId: "5", role: axValue("textbox"), name: axValue("Email"), value: axValue("a@x.com"), backendDOMNodeId: 101 }),
      axNode({ nodeId: "6", role: axValue("checkbox"), name: axValue("Remember"), properties: [prop("checked", true)] }),
      axNode({ nodeId: "7", role: axValue("combobox"), name: axValue("Country"), properties: [prop("expanded", false)] }),
      axNode({ nodeId: "8", role: axValue("button"), name: axValue("Gone"), properties: [prop("disabled", true)] }),
      axNode({ nodeId: "9", role: axValue("switch"), name: axValue("Dark"), properties: [prop("checked", "mixed")] }),
      axNode({ nodeId: "10", role: axValue("textbox"), name: axValue("Query"), properties: [prop("focused", true)], backendDOMNodeId: 102 }),
      axNode({ nodeId: "11", role: axValue("radio"), name: axValue("A"), properties: [prop("selected", true)] }),
    ];
    // Fail-closed redaction: Email is positively safe (retains value);
    // Query has no value anyway. Unknown editables would redact.
    const result = normalizeAxTree(raw, {
      allocateRef: () => `e-${SESSION32}-1-1`,
      valueSafety: new Map([[101, "safe"]]),
    });
    const byRole = new Map(result.nodes.map((node) => [`${node.role}:${node.name ?? ""}`, node]));
    const by = (role: string, name: string) => byRole.get(`${role}:${name}`);
    expect(by("heading", "Example Domain")?.level).toBe(1);
    expect(by("heading", "Example Domain")?.name).toBe("Example Domain");
    expect(by("text", "This domain is for use.")?.name).toBe("This domain is for use.");
    expect(by("link", "Learn more")?.ref).toBe(`e-${SESSION32}-1-1`);
    expect(by("button", "Gone")?.disabled).toBe(true);
    expect(by("textbox", "Email")?.value).toBe("a@x.com");
    expect(by("checkbox", "Remember")?.checked).toBe(true);
    expect(by("combobox", "Country")?.expanded).toBe(false);
    expect(by("radio", "A")?.selected).toBe(true);
    expect(result.totalNodes).toBe(result.includedNodes);
    expect(result.truncated).toBe(false);
  });

  it("skips ignored nodes but preserves named children", () => {
    const raw: RawAxNode[] = [
      axNode({ nodeId: "1", ignored: true, childIds: ["2"] }),
      axNode({ nodeId: "2", role: axValue("link"), name: axValue("Kept") }),
    ];
    const result = normalizeAxTree(raw, { allocateRef: () => null });
    expect(result.nodes.map((node) => node.name)).toEqual(["Kept"]);
  });

  it("flattens meaningless wrappers but keeps named ones", () => {
    const flat = normalizeAxTree(
      [
        axNode({ nodeId: "1", role: axValue("generic"), childIds: ["2"] }),
        axNode({ nodeId: "2", role: axValue("button"), name: axValue("Inner") }),
      ],
      { allocateRef: () => null },
    );
    expect(flat.nodes.map((node) => node.role)).toEqual(["button"]);

    const named = normalizeAxTree([axNode({ nodeId: "1", role: axValue("group"), name: axValue("Panel") })], {
      allocateRef: () => null,
    });
    expect(named.nodes).toHaveLength(1);
  });

  it("assigns refs only to actionable roles", () => {
    const result = normalizeAxTree(
      [
        axNode({ nodeId: "1", role: axValue("StaticText"), name: axValue("plain") }),
        axNode({ nodeId: "2", role: axValue("button"), name: axValue("Act") }),
      ],
      { allocateRef: () => `e-${SESSION32}-1-9` },
    );
    expect(result.nodes[0]?.ref).toBeUndefined();
    expect(result.nodes[1]?.ref).toBe(`e-${SESSION32}-1-9`);
  });

  it("truncates long fields and enforces node bounds with metadata", () => {
    const longName = "x".repeat(SNAPSHOT_MAX_FIELD_CHARS + 50);
    const raw: RawAxNode[] = [
      axNode({ nodeId: "1", role: axValue("heading"), name: axValue(longName) }),
      axNode({ nodeId: "2", role: axValue("link"), name: axValue("second") }),
      axNode({ nodeId: "3", role: axValue("link"), name: axValue("third") }),
    ];
    const bounded = normalizeAxTree(raw, { allocateRef: () => null, maxNodes: 2 });
    expect(bounded.nodes).toHaveLength(2);
    expect(bounded.truncated).toBe(true);
    expect(bounded.totalNodes).toBe(3);
    expect(bounded.includedNodes).toBe(2);
    expect(bounded.nodes[0]?.name?.length).toBe(SNAPSHOT_MAX_FIELD_CHARS);
    expect(SNAPSHOT_DEFAULT_MAX_NODES).toBe(500);
    expect(SNAPSHOT_HARD_MAX_NODES).toBe(1500);
  });

  it("redacts password values by backend id and by name heuristic", () => {
    const raw: RawAxNode[] = [
      axNode({ nodeId: "1", role: axValue("textbox"), name: axValue("Secret"), value: axValue("hunter2"), backendDOMNodeId: 7 }),
      axNode({ nodeId: "2", role: axValue("textbox"), name: axValue("Current password"), value: axValue("hunter3") }),
      axNode({ nodeId: "3", role: axValue("textbox"), name: axValue("Nickname"), value: axValue("plain"), backendDOMNodeId: 9 }),
    ];
    // Fail-closed model: password classification and unknown/absent
    // classification both redact; only "safe" retains a value.
    const result = normalizeAxTree(raw, {
      allocateRef: () => null,
      valueSafety: new Map([[7, "password"], [9, "safe"]]),
    });
    expect(result.nodes[0]?.value).toBeUndefined();
    expect(result.nodes[1]?.value).toBeUndefined();
    expect(result.nodes[2]?.value).toBe("plain");
  });

  it("fail-closed redaction: every uncertain editable value is redacted", () => {
    const raw: RawAxNode[] = [
      // Unknown: no backend id at all (missing backend node).
      axNode({ nodeId: "1", role: axValue("textbox"), name: axValue("Email"), value: axValue("a@x.com") }),
      // Unknown: backend id present but never probed/classified.
      axNode({ nodeId: "2", role: axValue("searchbox"), name: axValue("Query"), value: axValue("q"), backendDOMNodeId: 21 }),
      // Ambiguous editable control (combobox, unclassified).
      axNode({ nodeId: "3", role: axValue("combobox"), name: axValue("Country"), value: axValue("US"), backendDOMNodeId: 22 }),
      // Password-like AX semantics: protected=true.
      axNode({
        nodeId: "4",
        role: axValue("textbox"),
        name: axValue("Code"),
        value: axValue("1234"),
        backendDOMNodeId: 23,
        properties: [{ name: "protected", value: { value: true } }],
      }),
      // Positively safe: classified safe via DOM.describeNode.
      axNode({ nodeId: "5", role: axValue("textbox"), name: axValue("Nickname"), value: axValue("plain"), backendDOMNodeId: 24 }),
    ];
    const result = normalizeAxTree(raw, {
      allocateRef: () => null,
      valueSafety: new Map<number, "safe" | "password">([[24, "safe"]]),
    });
    expect(result.nodes[0]?.value).toBeUndefined();
    expect(result.nodes[1]?.value).toBeUndefined();
    expect(result.nodes[2]?.value).toBeUndefined();
    expect(result.nodes[3]?.value).toBeUndefined();
    expect(result.nodes[4]?.value).toBe("plain");
  });

  it("empty safety map redacts all editable values (describeNode/DOM failure)", () => {
    const raw: RawAxNode[] = [
      axNode({ nodeId: "1", role: axValue("textbox"), name: axValue("Email"), value: axValue("a@x.com"), backendDOMNodeId: 31 }),
      axNode({ nodeId: "2", role: axValue("textbox"), name: axValue("Nickname"), value: axValue("plain"), backendDOMNodeId: 32 }),
    ];
    const result = normalizeAxTree(raw, { allocateRef: () => null, valueSafety: new Map() });
    expect(result.nodes[0]?.value).toBeUndefined();
    expect(result.nodes[1]?.value).toBeUndefined();
  });

  it("keeps deterministic ordering", () => {
    const raw: RawAxNode[] = [
      axNode({ nodeId: "1", role: axValue("button"), name: axValue("First") }),
      axNode({ nodeId: "2", role: axValue("button"), name: axValue("Second") }),
    ];
    const first = normalizeAxTree(raw, { allocateRef: () => null });
    const second = normalizeAxTree(raw, { allocateRef: () => null });
    expect(first.text).toBe(second.text);
    expect(first.nodes).toEqual(second.nodes);
  });

  it("validates ref syntax and scans for leaked CDP keys", () => {
    expect(isElementRefSyntax(`e-${SESSION32}-1-9`)).toBe(true);
    expect(isSnapshotIdSyntax(`s-${SESSION32}-1`)).toBe(true);
    expect(isElementRefSyntax("e-aaaaaaaa-1-9")).toBe(false);
    expect(isSnapshotIdSyntax("s-aaaaaaaa-1")).toBe(false);
    expect(ELEMENT_REF_PATTERN.test("e1")).toBe(false);
    expect(SNAPSHOT_ID_PATTERN.test("9")).toBe(false);
    expect(findLeakedCdpKeys({ nodes: [{ ref: `e-${SESSION32}-1-1` }] })).toEqual([]);
    expect(findLeakedCdpKeys({ nodes: [{ backendNodeId: 5 }] })).toEqual(["backendNodeId"]);
    expect(findLeakedCdpKeys({ deep: [{ objectId: "x", nodeId: 1 }] }).sort()).toEqual(["nodeId", "objectId"]);
  });

  it("hard-caps the complete serialized payload under adversarial input", () => {
    expect(SNAPSHOT_MAX_SERIALIZED_BYTES).toBe(256 * 1024);
    const longName = "x".repeat(200);
    const longValue = "v".repeat(200);
    const raw: RawAxNode[] = [];
    for (let index = 0; index < 1500; index += 1) {
      const tricky = index % 3 === 0 ? "\"\\\n\u00e9\ud83d\ude00" : "";
      raw.push(
        axNode({
          nodeId: String(index + 1),
          role: axValue(index % 2 === 0 ? "link" : "button"),
          name: axValue(`${longName}${tricky}${String(index)}`),
          description: axValue(`${longName}${tricky}`),
          value: axValue(`${longValue}${tricky}`),
          ...(index === 0 ? { childIds: raw.map(() => "") } : {}),
        }),
      );
    }
    const envelope = { snapshotId: `s-${SESSION32}-0`, tabId: "t-x", url: "https://example.com/", title: "T" };
    const result = normalizeAxTree(raw, { allocateRef: () => null, envelope });
    const payloadBytes = new TextEncoder().encode(
      JSON.stringify({
        snapshotId: envelope.snapshotId,
        tabId: envelope.tabId,
        url: envelope.url,
        title: envelope.title,
        nodes: result.nodes,
        text: result.text,
        truncated: result.truncated,
        totalNodes: result.totalNodes,
        includedNodes: result.includedNodes,
      }),
    ).length;
    expect(payloadBytes).toBeLessThanOrEqual(SNAPSHOT_MAX_SERIALIZED_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.totalNodes).toBe(1500);
    expect(result.includedNodes).toBe(result.nodes.length);
    expect(result.includedNodes).toBeLessThan(1500);
  });

  it("keeps adversarial non-ASCII payloads under the cap with metadata preserved", () => {
    const raw: RawAxNode[] = [];
    for (let index = 0; index < 1500; index += 1) {
      raw.push(
        axNode({
          nodeId: String(index + 1),
          role: axValue("heading"),
          name: axValue(`"\u00e9\ud83d\ude00\\\n`.repeat(50)),
          description: axValue(`"\u00e9\ud83d\ude00\\\n`.repeat(50)),
        }),
      );
    }
    const envelope = { snapshotId: `s-${SESSION32}-0`, tabId: "t-x", url: "https://example.com/", title: "T" };
    const result = normalizeAxTree(raw, { allocateRef: () => null, envelope });
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ ...envelope, ...result })).length;
    expect(payloadBytes).toBeLessThanOrEqual(SNAPSHOT_MAX_SERIALIZED_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.totalNodes).toBe(1500);
    expect(result.includedNodes).toBe(result.nodes.length);
  });
});
