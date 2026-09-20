import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf-8");
}

const FORBIDDEN_BACKEND_TOKENS = ["playwright", "puppeteer", "selenium", "chrome-remote-interface", "chrome.debugger"];
const FORBIDDEN_IMPORT_SOURCES = ["playwright", "puppeteer", "selenium", "chrome-remote-interface", "chrome-launcher", "node:child_process"];

/** Strip line/block comments so doc mentions do not trip the guard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function forbiddenImports(source: string): string[] {
  const hits: string[] = [];
  const importPattern = /from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(source)) !== null) {
    const specifier = match[1] ?? "";
    if (FORBIDDEN_IMPORT_SOURCES.some((token) => specifier.toLowerCase().includes(token))) {
      hits.push(specifier);
    }
  }
  return hits;
}

describe("architecture boundaries", () => {
  it("has only the approved browser-automation dependency (playwright-core)", () => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    // Only playwright-core is approved; the full playwright bundle,
    // test runner, browser downloads, and rival frameworks stay out.
    for (const token of ["puppeteer", "selenium", "chrome-remote-interface"]) {
      const hit = Object.keys(deps).find((name) => name.toLowerCase().includes(token));
      expect(hit, `forbidden dependency containing ${token}`).toBeUndefined();
    }
    expect(Object.keys(deps).includes("playwright")).toBe(false);
    expect(Object.keys(deps).includes("@playwright/test")).toBe(false);
    expect(Object.keys(deps).includes("playwright-core")).toBe(true);
  });

  it("BrowserEngine and shared models reference no browser-library types", () => {
    for (const file of ["src/browser/BrowserEngine.ts", "src/browser/models.ts"]) {
      const raw = readSource(file);
      expect(forbiddenImports(raw), `${file} must not import browser libraries`).toEqual([]);
      const code = stripComments(raw).toLowerCase();
      for (const token of FORBIDDEN_BACKEND_TOKENS) {
        expect(code, `${file} must not mention ${token}`).not.toContain(token);
      }
    }
  });

  it("Arc discovery/launch modules stay outside the engine contract", () => {
    const engine = readSource("src/browser/BrowserEngine.ts");
    expect(engine).not.toMatch(/from\s+["']\.\/arc\//);
    for (const file of [
      "src/browser/arc/ArcDiscovery.ts",
      "src/browser/arc/ArcProfile.ts",
      "src/browser/arc/ArcLaunchConfig.ts",
    ]) {
      const source = readSource(file).toLowerCase();
      for (const token of ["playwright", "puppeteer", "chrome-remote-interface"]) {
        expect(source, `${file} must not mention ${token}`).not.toContain(token);
      }
    }
  });

  it("launch configuration never spawns a process", () => {
    for (const file of ["src/browser/arc/ArcLaunchConfig.ts", "src/browser/arc/ArcProfile.ts"]) {
      const raw = readSource(file);
      expect(forbiddenImports(raw), `${file} must not import child_process`).toEqual([]);
      const code = stripComments(raw);
      expect(code, `${file} must not call process-spawn APIs`).not.toMatch(
        /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/,
      );
    }
  });

    it("BrowserEngine exposes exactly the 24 required operations", () => {    const expected = [
      "connect",
      "disconnect",
      "status",
      "listTabs",
      "selectTab",
      "openTab",
      "closeTab",
      "navigate",
      "goBack",
      "goForward",
      "reload",
      "snapshot",
      "click",
      "fill",
      "type",
      "pressKey",
      "getText",
      "evaluate",
      "screenshot",
      "waitFor",
      "getConsole",
      "clearConsole",
      "getNetwork",
      "clearNetwork",
    ];
    const methods: string[] = [];
    const methodPattern = /^\s{2}(\w+)\(/gm;
    let match: RegExpExecArray | null;
    const source = readSource("src/browser/BrowserEngine.ts");
    while ((match = methodPattern.exec(source)) !== null) {
      methods.push(match[1] ?? "");
    }
    expect(methods).toEqual(expected);
    expect(methods).toHaveLength(24);
  });
});

describe("bridge boundaries", () => {
  it("exposes no unauthenticated network listener", () => {
    const files = [
      "src/bridge/mcpPipeServer.ts",
      "src/bridge/native-host/host.ts",
      "src/bridge/native-host/main.ts",
      "src/bridge/rpc.ts",
      "src/bridge/registry.ts",
      "src/bridge/cli.ts",
    ];
    for (const file of files) {
      const code = stripComments(readSource(file)).toLowerCase();
      for (const token of ["express", "fastify", "hono", "ws server", "websocketserver", "0.0.0.0", ".listen(80", ".listen(443"]) {
        expect(code, `${file} must not contain ${token}`).not.toContain(token);
      }
      expect(code, `${file} must not create TCP listeners`).not.toMatch(/\.listen\(\s*\d/);
    }
    // The only listen() call allowed is the named-pipe path (no ports).
    const pipeServer = stripComments(readSource("src/bridge/mcpPipeServer.ts"));
    const listens = [...pipeServer.matchAll(/\.listen\(([^)]*)\)/g)].map((match) => match[1] ?? "");
    expect(listens.length).toBeGreaterThan(0);
    for (const args of listens) {
      expect(args, "only named-pipe listen allowed").toMatch(/pipeName/);
    }
  });

  it("native host contains no browser business logic or shell execution", () => {
    const code = stripComments(readSource("src/bridge/native-host/host.ts")).toLowerCase();
    for (const token of ["chromium.launch", "browser.newpage", "evaluate(", "taskkill", "cmd.exe /c"]) {
      expect(code, `host must not contain ${token}`).not.toContain(token);
    }
  });

  it("extension manifest keeps minimal bridge permissions", () => {
    const manifest = JSON.parse(readSource("extension/manifest.json")) as {
      permissions?: unknown;
      host_permissions?: unknown;
    };
    // alarms exists solely for the wake-safe bridge reconnect schedule
    // (MV3 workers suspend; setTimeout retry alone cannot recover after
    // an MCP restart). No host, cookie, or history permissions.
    expect(manifest.permissions).toEqual(["debugger", "tabs", "storage", "nativeMessaging", "alarms"]);
    expect(manifest.host_permissions).toEqual([]);
  });

  it("bridge RPC core stays transport-only; typed browser methods live in BridgeRuntime", () => {
    const rpc = stripComments(readSource("src/bridge/rpc.ts")).toLowerCase();
    for (const token of ["listtabs", "screenshot", "evaluate"]) {
      expect(rpc, `bridge RPC must not contain ${token}`).not.toContain(token);
    }
    // snapshot.capture is a semantic RPC; no CDP passthrough.
    expect(rpc).not.toContain("snapshot");
    const runtime = stripComments(readSource("src/browser/extension/BridgeRuntime.ts"));
    // Explicit typed browser RPC surface: these are project-owned
    // bridge method names, never CDP method dispatch.
    for (const method of [
      "snapshot.capture",
      "runtime.evaluate",
      "page.screenshot",
      "wait.check",
    ]) {
      expect(runtime, `BridgeRuntime must route ${method}`).toContain(method);
    }
    for (const token of ["cdp.send", "debugger.command", "send_cdp", "Accessibility", "DOM.describeNode"]) {
      expect(runtime, `BridgeRuntime must not contain ${token}`).not.toContain(token);
    }
    const methods = ["bridge.hello", "bridge.ping", "bridge.status"];
    const cli = stripComments(readSource("src/bridge/cli.ts"));
    expect(cli).toContain("bridge.ping");
    // Transport lives in extension/src/bridge.ts; the three answered methods
    // live in the background request handler (no browser logic beyond them).
    const extBackground = stripComments(readSource("extension/src/background.ts"));
    for (const method of methods) {
      expect(extBackground, `extension background must answer ${method}`).toContain(method);
    }
  });
});

describe("extension engine boundaries", () => {
  it("ArcExtensionEngine exposes no browser-library or transport types", () => {
    for (const file of ["src/browser/extension/ArcExtensionEngine.ts", "src/browser/extension/BridgeRuntime.ts"]) {
      const raw = readSource(file);
      expect(forbiddenImports(raw), `${file} must not import browser libraries`).toEqual([]);
      const code = stripComments(raw).toLowerCase();
      for (const token of [...FORBIDDEN_BACKEND_TOKENS, "chrome.", "node:net", "child_process", "stdio", "named pipe"]) {
        expect(code, `${file} must not mention ${token}`).not.toContain(token);
      }
    }
    const engine = readSource("src/browser/extension/ArcExtensionEngine.ts");
    expect(engine).not.toMatch(/from\s+["']\.\.\/(cdp|arc)\//);
  });

  it("BrowserService stays backend-neutral", () => {
    const raw = readSource("src/browser/BrowserService.ts");
    expect(forbiddenImports(raw), "BrowserService must not import browser libraries").toEqual([]);
    expect(stripComments(raw).toLowerCase()).not.toContain("playwright");
  });

  it("browser_status schema represents the extension backend", async () => {
    const { BrowserStatusSchema } = await import("../src/server/tools/status.js");
    const parsed = BrowserStatusSchema.safeParse({
      connected: true,
      state: "connected",
      backend: "extension",
      profileMode: "normal-running-arc",
      selectedTabId: null,
      extensionConnected: true,
      relayConnected: true,
      pipeAuthenticated: true,
      bridgeProtocolVersion: 1,
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
    });
    expect(parsed.success).toBe(true);
    // Legacy disconnected placeholder still validates.
    const legacy = BrowserStatusSchema.safeParse({
      connected: false,
      state: "disconnected",
      backend: "none",
      profileMode: "dedicated-mcp-profile",
      selectedTabId: null,
      reason: "browser-engine-not-implemented",
    });
    expect(legacy.success).toBe(true);
  });
});

describe("navigation boundaries", () => {
  it("navigation uses typed RPC and chrome.tabs only, with no new permissions", () => {
    const background = stripComments(readSource("extension/src/background.ts"));
    for (const method of ["navigation.navigate", "navigation.back", "navigation.forward", "navigation.reload"]) {
      expect(background, `background must route ${method}`).toContain(method);
    }
    // Scope to the tab/navigation routing region: the diagnostics block
    // legitimately uses chrome.debugger for its own capability probes.
    const routingRegion = background.slice(background.indexOf("// Chrome truth stays"));
    expect(routingRegion).not.toContain("debugger.attach");
    expect(routingRegion).not.toContain("Page.navigate");
    const manifest = JSON.parse(readSource("extension/manifest.json")) as {
      permissions?: unknown;
      host_permissions?: unknown;
    };
    expect(manifest.permissions).toEqual(["debugger", "tabs", "storage", "nativeMessaging", "alarms"]);
    expect(manifest.host_permissions).toEqual([]);
  });

  it("extension registers exactly one onRemoteRequest dispatcher", () => {
    const background = stripComments(readSource("extension/src/background.ts"));
    const registrations = [...background.matchAll(/\.onRemoteRequest\s*\(/g)];
    expect(registrations).toHaveLength(1);
  });

  it("snapshot and later operations are real implementations in the extension engine", () => {
    const engine = stripComments(readSource("src/browser/extension/ArcExtensionEngine.ts"));
    // snapshot + interactions + page tools are all real; the
    // notImplemented helper is gone (CdpBrowserEngine keeps its own stubs).
    for (const operation of ["click", "fill", "type", "pressKey", "getText", "screenshot", "evaluate", "waitFor"]) {
      expect(engine).not.toContain(`notImplemented("${operation}")`);
    }
    expect(engine).not.toContain("browserOperationNotImplemented");
  });

  it("interaction path uses only the fixed CDP allowlist (Runtime.evaluate is evaluate-scoped)", () => {
    const ext = stripComments(readSource("extension/src/snapshot.ts"));
    for (const method of [
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getContentQuads",
      "DOM.focus",
      "Input.dispatchMouseEvent",
      "Input.dispatchKeyEvent",
      "Input.insertText",
      "Accessibility.getPartialAXTree",
    ]) {
      expect(ext, `extension interactions must allowlist ${method}`).toContain(method);
    }
    // Runtime.evaluate is allowlisted ONLY for the explicit evaluate
    // path (evaluateElement -> runtime.evaluate bridge method). Prove this
    // structurally: interaction entry points (click/fill/type/pressKey/
    // getText) and the snapshot capture / wait-corpus / screenshot helpers
    // never reference it. The shared send() gate and evaluateElement own
    // the only mentions; toProjectEvaluateValue only projects results.
    expect(ext).not.toContain("Runtime.callFunctionOn");
    expect(ext).not.toContain("DOM.click");
    for (const fn of [
      "async clickElement(",
      "async fillElement(",
      "async typeIntoElement(",
      "async pressKeyOnTab(",
      "async getElementText(",
      "async capture(",
      "async captureScreenshot(",
      "async waitTextCorpus(",
      "async waitCheck(",
    ]) {
      const start = ext.indexOf(fn);
      expect(start, `extension must define ${fn}`).toBeGreaterThanOrEqual(0);
      // Slice to the next top-level method marker (two-space "async " or
      // "private async ") to bound the function body structurally.
      const rest = ext.slice(start + fn.length);
      const nextMatch = rest.search(/\n  (?:private )?async \w+\(/);
      const body = nextMatch < 0 ? rest : rest.slice(0, nextMatch);
      expect(body, `${fn} must not reference Runtime.evaluate`).not.toContain("Runtime.evaluate");
    }
    expect(ext).toContain("async evaluateElement(");
    const background = stripComments(readSource("extension/src/background.ts"));
    for (const method of [
      "interaction.click",
      "interaction.fill",
      "interaction.type",
      "interaction.pressKey",
      "interaction.getText",
      "runtime.evaluate",
      "page.screenshot",
      "wait.check",
    ]) {
      expect(background, `background must route ${method}`).toContain(method);
    }
    // No generic CDP RPC: no caller-supplied method names anywhere.
    for (const token of ["cdp.send", "debugger.command", "chrome.call", "runtime.call"]) {
      expect(background.toLowerCase(), `background must not contain ${token}`).not.toContain(token);
      expect(ext.toLowerCase(), `snapshot module must not contain ${token}`).not.toContain(token);
    }
    const registrations = [...background.matchAll(/\.onRemoteRequest\s*\(/g)];
    expect(registrations).toHaveLength(1);
    const engine = stripComments(readSource("src/browser/extension/ArcExtensionEngine.ts"));
    for (const token of ["Accessibility", "DOM.describeNode", "sendCommand", "cdp.send"]) {
      expect(engine, `ArcExtensionEngine must not contain ${token}`).not.toContain(token);
    }
    const runtime = stripComments(readSource("src/browser/extension/BridgeRuntime.ts"));
    // CDP-level tokens never appear; typed bridge method names below are
    // the project-owned RPC surface (asserted explicitly as routed).
    for (const token of ["cdp.send", "Accessibility", "DOM.describeNode", "Input.dispatch"]) {
      expect(runtime, `BridgeRuntime must not contain ${token}`).not.toContain(token);
    }
    // Bridge method names are the typed RPC surface (not CDP): these are
    // expected in BridgeRuntime and background routing.
    for (const method of ["runtime.evaluate", "page.screenshot", "wait.check"]) {
      expect(runtime, `BridgeRuntime must route ${method}`).toContain(method);
    }
    const manifest = JSON.parse(readSource("extension/manifest.json")) as {
      permissions?: unknown;
      host_permissions?: unknown;
    };
    expect(manifest.permissions).toEqual(["debugger", "tabs", "storage", "nativeMessaging", "alarms"]);
    expect(manifest.host_permissions).toEqual([]);
  });

  it("page tools are registered with evaluate/screenshot/wait_for", () => {
    const server = stripComments(readSource("src/server/server.ts"));
    expect(server).toContain("registerInteractionTools");
    expect(server).toContain("registerPageTools");
    const engine = stripComments(readSource("src/browser/extension/ArcExtensionEngine.ts"));
    for (const operation of ["screenshot", "evaluate", "waitFor"]) {
      expect(engine).not.toContain(`notImplemented("${operation}")`);
    }
    const pageTools = stripComments(readSource("src/server/tools/pageTools.ts"));
    for (const tool of ["browser_evaluate", "browser_screenshot", "browser_wait_for"]) {
      expect(pageTools).toContain(tool);
    }
    // Screenshot uses proper MCP image content, not textual base64 JSON.
    expect(pageTools).toContain('type: "image"');
    const interaction = stripComments(readSource("src/server/tools/interaction.ts"));
    for (const tool of ["browser_click", "browser_fill", "browser_type", "browser_press_key", "browser_get_text"]) {
      expect(interaction).toContain(tool);
    }
    expect(interaction).not.toContain("browser_evaluate");
    expect(interaction).not.toContain("browser_screenshot");
    expect(interaction).not.toContain("browser_wait_for");
  });

  it("deterministic extension build identity (no timestamps)", () => {
    const build = stripComments(readSource("extension/build.mjs"));
    expect(build).not.toContain("toISOString");
    expect(build).not.toContain("Date.now");
    expect(build).toContain("fingerprint");
    const fingerprint = stripComments(readSource("extension/fingerprint.mjs"));
    expect(fingerprint).toContain("sha256");
  });

  it("snapshot keeps the allowlisted debugger boundary (evaluate is scoped)", () => {
    // No arbitrary CDP surface: MCP/Service/Engine never accept CDP method
    // strings; the extension sends a fixed allowlist only.
    const engine = stripComments(readSource("src/browser/extension/ArcExtensionEngine.ts"));
    for (const token of ["Accessibility", "DOM.describeNode", "sendCommand", "cdp.send"]) {
      expect(engine, `ArcExtensionEngine must not contain ${token}`).not.toContain(token);
    }
    const service = stripComments(readSource("src/browser/BrowserService.ts"));
    for (const token of ["Accessibility", "Runtime.evaluate", "sendCommand"]) {
      expect(service, `BrowserService must not contain ${token}`).not.toContain(token);
    }
    const snapshotTool = stripComments(readSource("src/server/tools/snapshot.ts"));
    for (const token of ["Runtime.evaluate", "sendCommand", "Bridgeruntime", "chrome."]) {
      expect(snapshotTool.toLowerCase(), `snapshot tool must not contain ${token}`).not.toContain(token.toLowerCase());
    }
    // The tool description legitimately says "Accessibility snapshot"; the
    // guard above targets CDP method usage, not the English word.
    expect(snapshotTool).toContain("Accessibility");
    const snapshotExt = stripComments(readSource("extension/src/snapshot.ts"));
    for (const method of ["Accessibility.enable", "Accessibility.getFullAXTree", "DOM.enable", "DOM.describeNode", "Runtime.evaluate", "Page.captureScreenshot"]) {
      expect(snapshotExt, `extension snapshot must allowlist ${method}`).toContain(method);
    }
    expect(snapshotExt).not.toContain("Runtime.callFunctionOn");
    const background = stripComments(readSource("extension/src/background.ts"));
    expect(background).toContain("snapshot.capture");
    // Only the diagnostics block may use chrome.debugger outside the
    // snapshot module; tab/navigation routing never attaches the debugger.
    const routingRegion = background.slice(background.indexOf("// Chrome truth stays"));
    const snapshotModuleRegion = routingRegion.slice(routingRegion.indexOf("snapshotManager"));
    expect(snapshotModuleRegion).not.toContain("Page.navigate");
    // Evaluate routing lives in the same single dispatcher but outside
    // the snapshot capture region: snapshot.capture itself never evaluates.
    const captureRegion = snapshotModuleRegion.slice(0, snapshotModuleRegion.indexOf("interaction.click"));
    expect(captureRegion).not.toContain("Runtime.evaluate");
    const registrations = [...background.matchAll(/\.onRemoteRequest\s*\(/g)];
    expect(registrations).toHaveLength(1);
  });

  it("keeps the fixed allowlist with no generic surface or Page.enable", () => {
    const ext = stripComments(readSource("extension/src/snapshot.ts"));
    // Observability adds Runtime.enable/Network.enable as narrow observability
    // capabilities only (asserted in the dedicated observability test below). Every
    // other sensitive/body/traversal/storage surface stays absent.
    for (const token of ["Runtime.callFunctionOn", "Runtime.getProperties", "DOM.getOuterHTML", "Page.enable", "Target.", "Storage.", "Browser.", "Network.getResponseBody", "Network.getRequestPostData", "Network.set", "ExtraInfo"]) {
      expect(ext, `extension must not contain ${token}`).not.toContain(token);
    }
    // The two new production methods are the only additions.
    expect(ext).toContain("Page.captureScreenshot");
    const background = stripComments(readSource("extension/src/background.ts"));
    for (const token of ["cdp.send", "debugger.command", "chrome.call", "runtime.call", "callFunctionOn", "objectId", "contextId", "backendNodeId", "nodeId"]) {
      expect(background, `background must not contain ${token}`).not.toContain(token);
    }
  });

  it("observability keeps the narrow capability boundary (no bodies, no generic events)", () => {
    const ext = stripComments(readSource("extension/src/snapshot.ts"));
    // The ONLY new production CDP commands are the two enables.
    for (const method of ["Runtime.enable", "Network.enable"]) {
      expect(ext, `extension must allowlist ${method}`).toContain(method);
    }
    // Bodies/post-data/traversal/storage surfaces stay absent.
    for (const token of ["Network.getResponseBody", "Network.getRequestPostData", "Runtime.getProperties", "Storage."]) {
      expect(ext, `extension must not contain ${token}`).not.toContain(token);
    }
    // Explicit observability bridge RPCs only: console + network get/clear.
    const background = stripComments(readSource("extension/src/background.ts"));
    for (const method of [
      "observability.consoleGet",
      "observability.consoleClear",
      "observability.networkGet",
      "observability.networkClear",
    ]) {
      expect(background, `background must route ${method}`).toContain(method);
    }
    // No generic debugger-event or CDP bridge: raw events never cross.
    for (const token of ["debugger.event", "cdp.send", "debugger.command", "send_cdp"]) {
      expect(background, `background must not contain ${token}`).not.toContain(token);
      expect(ext, `snapshot module must not contain ${token}`).not.toContain(token);
    }
    const registrations = [...background.matchAll(/\.onRemoteRequest\s*\(/g)];
    expect(registrations).toHaveLength(1);
    // Capability map: console -> Runtime.enable only; network -> Network.enable only.
    expect(ext).toContain('"observability-console"');
    expect(ext).toContain('"observability-network"');
    // Public models expose no raw CDP ids.
    for (const file of ["src/browser/models.ts", "src/server/tools/observability.ts"]) {
      const code = stripComments(readSource(file)).toLowerCase();
      for (const token of ["requestid", "objectid", "executioncontextid", "backendnodeid"]) {
        expect(code, `${file} must not contain ${token}`).not.toContain(token);
      }
    }
    // Engine never touches CDP method strings; the tools register only observability names.
    const engine = stripComments(readSource("src/browser/extension/ArcExtensionEngine.ts"));
    for (const token of ["Runtime.enable", "Network.enable", "sendCommand", "Accessibility", "DOM.describeNode"]) {
      expect(engine, `ArcExtensionEngine must not contain ${token}`).not.toContain(token);
    }
    const runtime = stripComments(readSource("src/browser/extension/BridgeRuntime.ts"));
    for (const method of [
      "observability.consoleGet",
      "observability.consoleClear",
      "observability.networkGet",
      "observability.networkClear",
    ]) {
      expect(runtime, `BridgeRuntime must route ${method}`).toContain(method);
    }
    for (const token of ["cdp.send", "Runtime.enable", "Network.enable", "Accessibility", "DOM.describeNode"]) {
      expect(runtime, `BridgeRuntime must not contain ${token}`).not.toContain(token);
    }
    const observabilityTool = stripComments(readSource("src/server/tools/observability.ts"));
    for (const tool of ["browser_console", "browser_network"]) {
      expect(observabilityTool).toContain(tool);
    }
    expect(observabilityTool).not.toContain("browser_console_extra");
    // Manifest unchanged; no extra tools.
    const manifest = JSON.parse(readSource("extension/manifest.json")) as {
      permissions?: unknown;
      host_permissions?: unknown;
    };
    expect(manifest.permissions).toEqual(["debugger", "tabs", "storage", "nativeMessaging", "alarms"]);
    expect(manifest.host_permissions).toEqual([]);
    const server = stripComments(readSource("src/server/server.ts"));
    expect(server).toContain("registerObservabilityTools");
    for (const file of [
      "src/server/server.ts",
      "src/server/tools/observability.ts",
      "src/browser/BrowserService.ts",
      "src/browser/extension/ArcExtensionEngine.ts",
    ]) {
      const code = stripComments(readSource(file));
      expect(code).not.toContain("browser_console_clear");
      expect(code).not.toContain("browser_network_clear");
      expect(code).not.toContain("browser_observe");
    }
    // Fingerprint includes every extension-consumed shared observability source.
    const fingerprint = stripComments(readSource("extension/fingerprint.mjs"));
    for (const shared of [
      "src/observability/observabilityPolicy",
      "src/observability/ConsoleMonitor",
      "src/observability/NetworkMonitor",
      "src/security/Redaction",
    ]) {
      expect(fingerprint, `fingerprint must include ${shared}`).toContain(shared);
    }
  });
});
