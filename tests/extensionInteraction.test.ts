import { describe, expect, it } from "vitest";
import {
  DebuggerSessionManager,
  createMemorySnapshotSessionStorage,
  type DebuggerChrome,
  type SnapshotTabRecord,
} from "../extension/src/snapshot.js";
import { INTERACTION_TEXT_LIMIT_BYTES } from "../src/browser/interactionPolicy.js";

const SESSION = "a".repeat(32);
const SESSION_ALT = "b".repeat(32);
const PROJECT = `t-${"a".repeat(32)}-11`;
const OTHER_PROJECT = `t-${"a".repeat(32)}-22`;

type AxNode = Record<string, unknown>;

function textboxTree(): AxNode[] {
  return [
    {
      nodeId: "1",
      role: { value: "heading" },
      name: { value: "Interaction Fixture" },
      backendDOMNodeId: 101,
      childIds: ["2", "3", "4", "5"],
    },
    {
      nodeId: "2",
      role: { value: "textbox" },
      name: { value: "Name" },
      value: { value: "known" },
      backendDOMNodeId: 102,
    },
    {
      nodeId: "3",
      role: { value: "textbox" },
      name: { value: "Password" },
      value: { value: "hunter2" },
      backendDOMNodeId: 103,
    },
    { nodeId: "4", role: { value: "button" }, name: { value: "Submit" }, backendDOMNodeId: 104 },
    {
      nodeId: "5",
      role: { value: "checkbox" },
      name: { value: "Agree" },
      backendDOMNodeId: 105,
    },
  ];
}

interface Harness {
  manager: DebuggerSessionManager;
  commands: Array<{ method: string; params: Record<string, unknown> | undefined }>;
  attaches: number[];
  describeImpl: (backendNodeId: number) => AxNode;
  quads: unknown;
  partialNodes: AxNode[] | null;
  partialFails: boolean;
}

function harness(options: {
  describeImpl?: (backendNodeId: number) => AxNode;
  quads?: unknown;
  partialNodes?: AxNode[] | null;
  partialFails?: boolean;
  sessionId?: string;
  tabUrl?: string;
} = {}): Harness {
  const commands: Harness["commands"] = [];
  const attaches: number[] = [];
  const records = new Map<number, SnapshotTabRecord>([
    [11, { id: PROJECT, url: options.tabUrl ?? "https://fixture.local/", title: "Fixture" }],
  ]);
  const describeImpl =
    options.describeImpl ??
    ((backendNodeId: number) =>
      backendNodeId === 105
        ? { node: { nodeName: "INPUT", attributes: ["type", "checkbox"] } }
        : backendNodeId === 103
          ? { node: { nodeName: "INPUT", attributes: ["type", "password"] } }
          : { node: { nodeName: "INPUT", attributes: ["type", "text"] } });
  const debuggerChrome: DebuggerChrome = {
    attach: (tabId) => {
      attaches.push(tabId);
      return Promise.resolve();
    },
    sendCommand: (tabId, method, params) => {
      void tabId;
      commands.push({ method, params });
      if (method === "DOM.describeNode") {
        const backendNodeId = typeof params?.["backendNodeId"] === "number" ? params["backendNodeId"] : -1;
        return Promise.resolve(describeImpl(backendNodeId));
      }
      if (method === "DOM.getContentQuads") {
        return Promise.resolve({ quads: options.quads ?? [[[0, 0, 100, 0, 100, 20, 0, 20]]] });
      }
      if (method === "Accessibility.getPartialAXTree") {
        if (options.partialFails === true) {
          return Promise.reject(new Error("partial unavailable"));
        }
        const nodes = options.partialNodes ?? [
          { nodeId: "1", role: { value: "heading" }, name: { value: "Interaction Fixture" }, backendDOMNodeId: 101 },
        ];
        return Promise.resolve({ nodes });
      }
      if (method === "Accessibility.getFullAXTree") {
        return Promise.resolve({ nodes: textboxTree() });
      }
      return Promise.resolve({});
    },
    detach: () => Promise.resolve(),
    onDetach: () => undefined,
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
      return Promise.reject(Object.assign(new Error("unknown tab"), { code: "TAB_INVALID_ID" }));
    },
    (chromeId) => records.get(chromeId) ?? null,
    createMemorySnapshotSessionStorage(),
    { generateSessionId: () => options.sessionId ?? SESSION },
  );
  return {
    manager,
    commands,
    attaches,
    describeImpl,
    quads: options.quads,
    partialNodes: options.partialNodes ?? null,
    partialFails: options.partialFails ?? false,
  };
}

async function refs(fixture: Harness): Promise<Record<string, string>> {
  const captured = await fixture.manager.capture(PROJECT);
  const byName = new Map<string, string>();
  for (const node of captured.nodes) {
    if (node.ref !== undefined && node.name !== undefined) {
      byName.set(node.name, node.ref);
    }
  }
  const heading = captured.nodes.find((node) => node.role === "heading")?.ref;
  if (heading !== undefined) {
    byName.set("__heading", heading);
  }
  return Object.fromEntries(byName);
}

describe("reference behavior", () => {
  it("rejects stale/malformed/foreign/old-snapshot/old-session refs", async () => {
    const fixture = harness();
    const first = await refs(fixture);
    const textbox = first["Name"];
    if (textbox === undefined) {
      throw new Error("expected a textbox ref");
    }
    await expect(fixture.manager.clickElement(PROJECT, "nope")).rejects.toMatchObject({ code: "SNAPSHOT_FAILED" });
    await expect(fixture.manager.clickElement(OTHER_PROJECT, textbox)).rejects.toMatchObject({ code: "STALE_ELEMENT" });
    await expect(fixture.manager.clickElement(PROJECT, `e-${SESSION_ALT}-0-1`)).rejects.toMatchObject({
      code: "STALE_ELEMENT",
    });
    // Previous-snapshot ref: capture again, then the old ref is dead.
    await fixture.manager.capture(PROJECT);
    await expect(fixture.manager.clickElement(PROJECT, textbox)).rejects.toMatchObject({ code: "STALE_ELEMENT" });
  });

  it("malformed worker-session-old ref never retargets; lifecycle invalidates", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const button = live["Submit"];
    if (button === undefined) {
      throw new Error("expected a button ref");
    }
    // Lifecycle: navigation / detach / tab close invalidate latest refs.
    fixture.manager.handleTabUpdated(11, { status: "loading" });
    expect(fixture.manager.isRefValid(PROJECT, button)).toBe(false);
    const fresh = await refs(fixture);
    const freshButton = fresh["Submit"];
    if (freshButton === undefined) {
      throw new Error("expected a fresh button ref");
    }
    fixture.manager.handleDetach(11);
    expect(fixture.manager.isRefValid(PROJECT, freshButton)).toBe(false);
    const newer = await refs(fixture);
    const newerButton = newer["Submit"];
    if (newerButton === undefined) {
      throw new Error("expected a newer button ref");
    }
    fixture.manager.handleTabRemoved(11);
    expect(fixture.manager.isRefValid(PROJECT, newerButton)).toBe(false);
    // Cross-tab mismatch never retargets.
    await expect(fixture.manager.clickElement(OTHER_PROJECT, newerButton)).rejects.toMatchObject({
      code: "STALE_ELEMENT",
    });
  });
});

describe("click", () => {
  it("scrolls, reads a valid quad, dispatches moved/pressed/released, invalidates refs", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const button = live["Submit"];
    if (button === undefined) {
      throw new Error("expected a button ref");
    }
    const result = await fixture.manager.clickElement(PROJECT, button);
    expect(result).toEqual({ clicked: true });
    const methods = fixture.commands.map((command) => command.method);
    expect(methods).toContain("DOM.scrollIntoViewIfNeeded");
    expect(methods).toContain("DOM.getContentQuads");
    const mouse = fixture.commands.filter((command) => command.method === "Input.dispatchMouseEvent");
    expect(mouse.map((command) => command.params?.["type"])).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(mouse[0]?.params?.["button"]).toBe("none");
    expect(mouse[1]?.params?.["button"]).toBe("left");
    expect(mouse[2]?.params?.["button"]).toBe("left");
    expect(mouse[0]?.params?.["x"]).toBe(50);
    expect(mouse[0]?.params?.["y"]).toBe(10);
    expect(fixture.manager.isRefValid(PROJECT, button)).toBe(false);
  });

  it("rejects no-quad and zero-area geometry without dispatching input", async () => {
    for (const quads of [[], [[[0, 0, 0, 0, 0, 0, 0, 0]]], [[[NaN, 0, 1, 0, 1, 1, 0, 1]]]]) {
      const fixture = harness({ quads: quads as unknown });
      const live = await refs(fixture);
      const button = live["Submit"];
      if (button === undefined) {
        throw new Error("expected a button ref");
      }
      await expect(fixture.manager.clickElement(PROJECT, button)).rejects.toMatchObject({
        code: "ELEMENT_NOT_INTERACTABLE",
      });
      expect(fixture.commands.some((command) => command.method === "Input.dispatchMouseEvent")).toBe(false);
      // Failed-before-dispatch leaves refs live.
      expect(fixture.manager.isRefValid(PROJECT, button)).toBe(true);
    }
  });

  it("rejects file inputs without opening a picker", async () => {
    const fixture = harness({
      describeImpl: () => ({ node: { nodeName: "INPUT", attributes: ["type", "file"] } }),
    });
    const live = await refs(fixture);
    const button = live["Submit"];
    if (button === undefined) {
      throw new Error("expected a button ref");
    }
    await expect(fixture.manager.clickElement(PROJECT, button)).rejects.toMatchObject({
      code: "ELEMENT_NOT_INTERACTABLE",
    });
    expect(fixture.commands.some((command) => command.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("replays a neuromotor path with hover and hold when humanized", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const button = live["Submit"];
    if (button === undefined) {
      throw new Error("expected a button ref");
    }
    const result = await fixture.manager.clickElement(PROJECT, button, true);
    expect(result).toEqual({ clicked: true });
    const mouse = fixture.commands.filter((command) => command.method === "Input.dispatchMouseEvent");
    const types = mouse.map((command) => command.params?.["type"]);
    // Many moved waypoints, then exactly one press/release pair.
    expect(types.filter((type) => type === "mouseMoved").length).toBeGreaterThan(3);
    expect(types.slice(-2)).toEqual(["mousePressed", "mouseReleased"]);
    // Integer coordinates only; press lands inside the 100x20 fixture box.
    for (const command of mouse) {
      expect(Number.isInteger(command.params?.["x"])).toBe(true);
      expect(Number.isInteger(command.params?.["y"])).toBe(true);
    }
    const pressed = mouse.find((command) => command.params?.["type"] === "mousePressed");
    const px = Number(pressed?.params?.["x"]);
    const py = Number(pressed?.params?.["y"]);
    expect(px).toBeGreaterThanOrEqual(0);
    expect(px).toBeLessThanOrEqual(100);
    expect(py).toBeGreaterThanOrEqual(0);
    expect(py).toBeLessThanOrEqual(20);
    expect(fixture.manager.isRefValid(PROJECT, button)).toBe(false);
  });
});

describe("fill", () => {
  it("replaces normal input text via focus + clear + insertText (Unicode)", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const textbox = live["Name"];
    if (textbox === undefined) {
      throw new Error("expected a textbox ref");
    }
    await fixture.manager.fillElement(PROJECT, textbox, "hello 世界🙂");
    const methods = fixture.commands.map((command) => command.method);
    expect(methods).toContain("DOM.focus");
    expect(methods).toContain("Input.insertText");
    const keys = fixture.commands.filter((command) => command.method === "Input.dispatchKeyEvent");
    expect(keys.length).toBeGreaterThanOrEqual(3);
    const inserted = fixture.commands.find((command) => command.method === "Input.insertText");
    expect(inserted?.params?.["text"]).toBe("hello 世界🙂");
    expect(fixture.manager.isRefValid(PROJECT, textbox)).toBe(false);
  });

  it("fills textarea and password (write allowed); rejects checkbox/radio/file/non-editable", async () => {
    const textareas = harness({
      describeImpl: () => ({ node: { nodeName: "TEXTAREA", attributes: [] } }),
    });
    const areaRefs = await refs(textareas);
    const area = areaRefs["Name"];
    if (area === undefined) {
      throw new Error("expected a textbox ref");
    }
    await expect(textareas.manager.fillElement(PROJECT, area, "x")).resolves.toEqual({ filled: true });

    const passwords = harness();
    const passwordRefs = await refs(passwords);
    const password = passwordRefs["Password"];
    if (password === undefined) {
      throw new Error("expected a password ref");
    }
    await expect(passwords.manager.fillElement(PROJECT, password, "s3cret")).resolves.toEqual({ filled: true });

    const checkboxes = harness();
    const checkboxRefs = await refs(checkboxes);
    const checkbox = checkboxRefs["Agree"];
    if (checkbox === undefined) {
      throw new Error("expected a checkbox ref");
    }
    await expect(checkboxes.manager.fillElement(PROJECT, checkbox, "x")).rejects.toMatchObject({
      code: "ELEMENT_NOT_EDITABLE",
    });

    const files = harness({ describeImpl: () => ({ node: { nodeName: "INPUT", attributes: ["type", "file"] } }) });
    const fileRefs = await refs(files);
    const fileTarget = fileRefs["Name"];
    if (fileTarget === undefined) {
      throw new Error("expected a textbox ref");
    }
    await expect(files.manager.fillElement(PROJECT, fileTarget, "x")).rejects.toMatchObject({
      code: "ELEMENT_NOT_EDITABLE",
    });

    const buttons = harness({
      describeImpl: () => ({ node: { nodeName: "BUTTON", attributes: [] } }),
    });
    const buttonRefs = await refs(buttons);
    const button = buttonRefs["Submit"];
    if (button === undefined) {
      throw new Error("expected a button ref");
    }
    await expect(buttons.manager.fillElement(PROJECT, button, "x")).rejects.toMatchObject({
      code: "ELEMENT_NOT_EDITABLE",
    });
  });

  it("rejects input[type=number] for fill and type without dispatching input", async () => {
    const numbers = harness({
      describeImpl: () => ({ node: { nodeName: "INPUT", attributes: ["type", "number"] } }),
    });
    const numberRefs = await refs(numbers);
    const target = numberRefs["Name"];
    if (target === undefined) {
      throw new Error("expected a textbox ref");
    }
    await expect(numbers.manager.fillElement(PROJECT, target, "42")).rejects.toMatchObject({
      code: "ELEMENT_NOT_EDITABLE",
    });
    expect(numbers.commands.some((command) => command.method === "Input.insertText")).toBe(false);
    expect(numbers.manager.isRefValid(PROJECT, target)).toBe(true);

    const numbersType = harness({
      describeImpl: () => ({ node: { nodeName: "INPUT", attributes: ["type", "number"] } }),
    });
    const numberTypeRefs = await refs(numbersType);
    const typeTarget = numberTypeRefs["Name"];
    if (typeTarget === undefined) {
      throw new Error("expected a textbox ref");
    }
    await expect(numbersType.manager.typeIntoElement(PROJECT, typeTarget, "42")).rejects.toMatchObject({
      code: "ELEMENT_NOT_EDITABLE",
    });
    expect(numbersType.commands.some((command) => command.method === "Input.insertText")).toBe(false);
    expect(numbersType.manager.isRefValid(PROJECT, typeTarget)).toBe(true);
  });

  it("rejects oversized text before any input dispatch", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const textbox = live["Name"];
    if (textbox === undefined) {
      throw new Error("expected a textbox ref");
    }
    const oversized = "x".repeat(INTERACTION_TEXT_LIMIT_BYTES + 1);
    await expect(fixture.manager.fillElement(PROJECT, textbox, oversized)).rejects.toMatchObject({
      code: "INVALID_TEXT",
    });
    expect(fixture.commands.some((command) => command.method === "Input.insertText")).toBe(false);
  });
});

describe("type", () => {
  it("inserts without a clear sequence and supports Unicode", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const textbox = live["Name"];
    if (textbox === undefined) {
      throw new Error("expected a textbox ref");
    }
    await fixture.manager.typeIntoElement(PROJECT, textbox, " 世界🙂");
    const keys = fixture.commands.filter((command) => command.method === "Input.dispatchKeyEvent");
    expect(keys).toHaveLength(0);
    const inserted = fixture.commands.find((command) => command.method === "Input.insertText");
    expect(inserted?.params?.["text"]).toBe(" 世界🙂");
    expect(fixture.manager.isRefValid(PROJECT, textbox)).toBe(false);
  });

  it("rejects non-editable targets and oversized text", async () => {
    const buttons = harness({
      describeImpl: () => ({ node: { nodeName: "BUTTON", attributes: [] } }),
    });
    const buttonRefs = await refs(buttons);
    const button = buttonRefs["Submit"];
    if (button === undefined) {
      throw new Error("expected a button ref");
    }
    await expect(buttons.manager.typeIntoElement(PROJECT, button, "x")).rejects.toMatchObject({
      code: "ELEMENT_NOT_EDITABLE",
    });
    const fixture = harness();
    const live = await refs(fixture);
    const textbox = live["Name"];
    if (textbox === undefined) {
      throw new Error("expected a textbox ref");
    }
    await expect(
      fixture.manager.typeIntoElement(PROJECT, textbox, "x".repeat(INTERACTION_TEXT_LIMIT_BYTES + 1)),
    ).rejects.toMatchObject({ code: "INVALID_TEXT" });
  });
});

describe("pressKey", () => {
  it("dispatches keyDown/keyUp for accepted keys and invalidates refs", async () => {
    const fixture = harness();
    await refs(fixture);
    await fixture.manager.pressKeyOnTab(PROJECT, "Enter");
    const keys = fixture.commands.filter((command) => command.method === "Input.dispatchKeyEvent");
    expect(keys.map((command) => command.params?.["type"])).toEqual(["keyDown", "keyUp"]);
    expect(keys[0]?.params?.["key"]).toBe("Enter");
  });

  it("supports modifiers and rejects invalid keys before CDP", async () => {
    const fixture = harness();
    await refs(fixture);
    const before = fixture.commands.length;
    await expect(fixture.manager.pressKeyOnTab(PROJECT, "Super+Enter")).rejects.toMatchObject({ code: "INVALID_KEY" });
    await expect(fixture.manager.pressKeyOnTab(PROJECT, "Shift")).rejects.toMatchObject({ code: "INVALID_KEY" });
    expect(fixture.commands.length).toBe(before);
    await fixture.manager.pressKeyOnTab(PROJECT, "Control+Enter");
    const last = fixture.commands.filter((command) => command.method === "Input.dispatchKeyEvent").at(-2);
    expect(last?.params?.["modifiers"]).toBe(2);
    await fixture.manager.pressKeyOnTab(PROJECT, "F1");
    await fixture.manager.pressKeyOnTab(PROJECT, "Control+a");
  });
});

describe("typeHuman", () => {
  it("inserts in chunks with pacing in insert mode and invalidates refs", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const textbox = live["Name"];
    if (textbox === undefined) {
      throw new Error("expected a textbox ref");
    }
    await fixture.manager.typeHumanElement(PROJECT, textbox, "hello world", 200, "insert");
    const inserts = fixture.commands.filter((command) => command.method === "Input.insertText");
    expect(inserts.length).toBeGreaterThan(1);
    expect(inserts.map((entry) => String(entry.params?.["text"])).join("")).toBe("hello world");
    expect(fixture.manager.isRefValid(PROJECT, textbox)).toBe(false);
  });

  it("emits real key events with dwell in keys mode (the default)", async () => {    const fixture = harness();
    const live = await refs(fixture);
    const textbox = live["Name"];
    if (textbox === undefined) {
      throw new Error("expected a textbox ref");
    }
    await fixture.manager.typeHumanElement(PROJECT, textbox, "hi", 200);
    const keys = fixture.commands.filter((command) => command.method === "Input.dispatchKeyEvent");
    expect(keys.map((command) => command.params?.["type"])).toEqual(["keyDown", "keyUp", "keyDown", "keyUp"]);
    // Text rides on keyDown (keyUp carries none); joined it spells the input.
    expect(keys.map((command) => String(command.params?.["text"] ?? "")).join("")).toBe("hi");
    expect(keys.every((command) => command.params?.["code"] === "KeyH" || command.params?.["code"] === "KeyI")).toBe(
      true,
    );
    expect(fixture.commands.some((command) => command.method === "Input.insertText")).toBe(false);
    expect(fixture.manager.isRefValid(PROJECT, textbox)).toBe(false);
  });

  it("emits bare key events with no pacing in rapid mode", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const textbox = live["Name"];
    if (textbox === undefined) {
      throw new Error("expected a textbox ref");
    }
    await fixture.manager.typeHumanElement(PROJECT, textbox, "hey!", 200, "rapid");
    const keys = fixture.commands.filter((command) => command.method === "Input.dispatchKeyEvent");
    // h,e,y,! down/up each with zero pacing between them.
    expect(keys.map((command) => command.params?.["type"])).toEqual([
      "keyDown",
      "keyUp",
      "keyDown",
      "keyUp",
      "keyDown",
      "keyUp",
      "keyDown",
      "keyUp",
    ]);
    expect(keys.map((command) => String(command.params?.["text"] ?? "")).join("")).toBe("hey!");
    expect(fixture.manager.isRefValid(PROJECT, textbox)).toBe(false);
  });

  it("forces insert mode for password fields even when keys is requested", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const password = live["Password"];
    if (password === undefined) {
      throw new Error("expected a password ref");
    }
    await fixture.manager.typeHumanElement(PROJECT, password, "s3cret", 200, "keys");
    const inserts = fixture.commands.filter((command) => command.method === "Input.insertText");
    expect(inserts.map((entry) => String(entry.params?.["text"])).join("")).toBe("s3cret");
    const keyTexts = fixture.commands
      .filter((command) => command.method === "Input.dispatchKeyEvent")
      .map((command) => String(command.params?.["text"] ?? ""));
    expect(keyTexts.join("")).toBe("");
  });

  it("rejects bad wpm, bad mode, keys budget overflow, non-editable, and oversized text", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const textbox = live["Name"];
    if (textbox === undefined) {
      throw new Error("expected a textbox ref");
    }
    await expect(fixture.manager.typeHumanElement(PROJECT, textbox, "hi", 5)).rejects.toMatchObject({
      code: "INVALID_TEXT",
    });
    await expect(
      fixture.manager.typeHumanElement(PROJECT, textbox, "hi", 80, "fast" as unknown as "keys"),
    ).rejects.toMatchObject({ code: "INVALID_TEXT" });
    await expect(
      fixture.manager.typeHumanElement(PROJECT, textbox, "x".repeat(1501), 80, "keys"),
    ).rejects.toMatchObject({ code: "INVALID_TEXT" });
    await expect(
      fixture.manager.typeHumanElement(PROJECT, textbox, "x".repeat(INTERACTION_TEXT_LIMIT_BYTES + 1)),
    ).rejects.toMatchObject({ code: "INVALID_TEXT" });
    const buttons = harness({ describeImpl: () => ({ node: { nodeName: "BUTTON", attributes: [] } }) });
    const buttonRefs = await refs(buttons);
    const button = buttonRefs["Submit"];
    if (button === undefined) {
      throw new Error("expected a button ref");
    }
    await expect(buttons.manager.typeHumanElement(PROJECT, button, "hi")).rejects.toMatchObject({
      code: "ELEMENT_NOT_EDITABLE",
    });
  });
});

describe("pressSequence", () => {
  it("dispatches ordered keys and invalidates refs", async () => {
    const fixture = harness();
    await refs(fixture);
    await fixture.manager.pressSequenceOnTab(PROJECT, ["Control+a", "Backspace", "Enter"], 0);
    const keys = fixture.commands.filter((command) => command.method === "Input.dispatchKeyEvent");
    // Control+a (2 events) + Backspace (2) + Enter (2).
    expect(keys.length).toBe(6);
  });

  it("rejects empty/oversized/invalid sequences before CDP", async () => {
    const fixture = harness();
    await refs(fixture);
    const before = fixture.commands.length;
    await expect(fixture.manager.pressSequenceOnTab(PROJECT, [])).rejects.toMatchObject({ code: "INVALID_KEY" });
    await expect(
      fixture.manager.pressSequenceOnTab(PROJECT, Array.from({ length: 51 }, () => "Enter")),
    ).rejects.toMatchObject({ code: "INVALID_KEY" });
    await expect(fixture.manager.pressSequenceOnTab(PROJECT, ["Super+Enter"])).rejects.toMatchObject({
      code: "INVALID_KEY",
    });
    await expect(fixture.manager.pressSequenceOnTab(PROJECT, ["Enter"], 5000)).rejects.toMatchObject({
      code: "INVALID_KEY",
    });
    expect(fixture.commands.length).toBe(before);
  });
});

describe("clickType", () => {
  it("clicks then types and submits in one call", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const textbox = live["Name"];
    if (textbox === undefined) {
      throw new Error("expected a textbox ref");
    }
    await fixture.manager.clickTypeElement(PROJECT, textbox, "hi", { humanize: false, submitKey: "Enter" });
    const methods = fixture.commands.map((command) => command.method);
    expect(methods).toContain("Input.dispatchMouseEvent");
    expect(methods).toContain("Input.insertText");
    expect(methods).toContain("Input.dispatchKeyEvent");
    expect(fixture.manager.isRefValid(PROJECT, textbox)).toBe(false);
  });

  it("rejects bad submit keys without leaking text", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const textbox = live["Name"];
    if (textbox === undefined) {
      throw new Error("expected a textbox ref");
    }
    await expect(
      fixture.manager.clickTypeElement(PROJECT, textbox, "hi", { submitKey: "Super+Enter" }),
    ).rejects.toMatchObject({ code: "INVALID_KEY" });
  });

  it("humanizes mouse and keystrokes by default and honors insert mode", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const textbox = live["Name"];
    if (textbox === undefined) {
      throw new Error("expected a textbox ref");
    }
    await fixture.manager.clickTypeElement(PROJECT, textbox, "hi", { wpm: 200, submitKey: "Enter" });
    const mouse = fixture.commands.filter((command) => command.method === "Input.dispatchMouseEvent");
    expect(mouse.filter((command) => command.params?.["type"] === "mouseMoved").length).toBeGreaterThan(3);
    const keys = fixture.commands.filter((command) => command.method === "Input.dispatchKeyEvent");
    // h, i (down/up each) + Enter submit (down/up).
    expect(keys.map((command) => command.params?.["type"])).toEqual([
      "keyDown",
      "keyUp",
      "keyDown",
      "keyUp",
      "keyDown",
      "keyUp",
    ]);
    expect(fixture.manager.isRefValid(PROJECT, textbox)).toBe(false);

    const insert = harness();
    const insertRefs = await refs(insert);
    const insertBox = insertRefs["Name"];
    if (insertBox === undefined) {
      throw new Error("expected a textbox ref");
    }
    await insert.manager.clickTypeElement(PROJECT, insertBox, "hi", { wpm: 200, mode: "insert" });
    expect(insert.commands.some((command) => command.method === "Input.insertText")).toBe(true);
    const insertKeys = insert.commands.filter((command) => command.method === "Input.dispatchKeyEvent");
    expect(insertKeys.map((command) => String(command.params?.["text"] ?? "")).join("")).toBe("");

    await expect(
      insert.manager.clickTypeElement(PROJECT, insertBox, "hi", { mode: "nope" as unknown as "keys" }),
    ).rejects.toMatchObject({ code: "INVALID_TEXT" });
  });
});

describe("getText", () => {
  it("returns heading semantic text without invalidating the ref", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const heading = live["__heading"];
    if (heading === undefined) {
      throw new Error("expected a heading ref");
    }
    const result = await fixture.manager.getElementText(PROJECT, heading);
    expect(result.source).toBe("accessibility");
    expect(result.role).toBe("heading");
    expect(result.text).toContain("Interaction Fixture");
    expect(fixture.manager.isRefValid(PROJECT, heading)).toBe(true);
  });

  it("redacts password and uncertain editable values; exposes safe values", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const password = live["Password"];
    if (password === undefined) {
      throw new Error("expected a password ref");
    }
    const passwordText = await fixture.manager.getElementText(PROJECT, password);
    expect(JSON.stringify(passwordText)).not.toContain("hunter2");
    expect(passwordText.text).not.toContain("hunter2");
    // Safe textbox value via a partial tree that carries backend ids.
    const safeFixture = harness({
      partialNodes: [
        {
          nodeId: "2",
          role: { value: "textbox" },
          name: { value: "Name" },
          value: { value: "known" },
          backendDOMNodeId: 102,
        },
      ],
    });
    await refs(safeFixture);
    const safeLive = await refs(safeFixture);
    const safe = safeLive["Name"];
    if (safe === undefined) {
      throw new Error("expected a safe textbox ref");
    }
    const safeText = await safeFixture.manager.getElementText(PROJECT, safe);
    expect(safeText.text).toContain("known");
  });

  it("falls back to getFullAXTree when partial is unavailable; detached node is stale", async () => {
    const fixture = harness({ partialFails: true });
    const live = await refs(fixture);
    const heading = live["__heading"];
    if (heading === undefined) {
      throw new Error("expected a heading ref");
    }
    const result = await fixture.manager.getElementText(PROJECT, heading);
    expect(result.text).toContain("Interaction Fixture");
    const methods = fixture.commands.map((command) => command.method);
    expect(methods).toContain("Accessibility.getFullAXTree");
  });
});

describe("secret hygiene", () => {
  it("sentinel fill secret never appears in results, snapshots, or errors", async () => {
    const sentinel = `test-secret-sentinel-${"9f".repeat(8)}`;
    const fixture = harness();
    const live = await refs(fixture);
    const password = live["Password"];
    if (password === undefined) {
      throw new Error("expected a password ref");
    }
    const filled = await fixture.manager.fillElement(PROJECT, password, sentinel);
    expect(JSON.stringify(filled)).not.toContain(sentinel);
    const captured = await fixture.manager.capture(PROJECT);
    expect(JSON.stringify(captured)).not.toContain(sentinel);
    const freshRefs = await refs(fixture);
    const freshPassword = freshRefs["Password"];
    if (freshPassword === undefined) {
      throw new Error("expected a fresh password ref");
    }
    const read = await fixture.manager.getElementText(PROJECT, freshPassword);
    expect(JSON.stringify(read)).not.toContain(sentinel);
    let staleMessage = "";
    try {
      await fixture.manager.fillElement(PROJECT, password, sentinel);
    } catch (error: unknown) {
      staleMessage = error instanceof Error ? error.message : String(error);
    }
    expect(staleMessage).not.toContain(sentinel);
  });

  it("uses only allowlisted CDP methods; never Runtime", async () => {
    const fixture = harness();
    const live = await refs(fixture);
    const button = live["Submit"];
    const textbox = live["Name"];
    if (button === undefined || textbox === undefined) {
      throw new Error("expected refs");
    }
    await fixture.manager.clickElement(PROJECT, button);
    const allowed = new Set([
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
    for (const command of fixture.commands) {
      expect(allowed.has(command.method), command.method).toBe(true);
      expect(command.method).not.toContain("Runtime");
    }
    expect(JSON.stringify(fixture.commands)).not.toContain("Runtime.evaluate");
  });
});
