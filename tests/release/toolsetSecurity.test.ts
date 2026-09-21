import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extensionIdFromPublicKeyBase64, extensionOrigin } from "../../src/bridge/extensionIdentity.js";
import { NATIVE_HOST_NAME, NATIVE_HOST_REGISTRY_KEY } from "../../src/bridge/constants.js";
import { SMALL_FRAME_MAX_BYTES, LARGE_RESPONSE_FRAME_MAX_BYTES, SCREENSHOT_MAX_DECODED_BYTES } from "../../src/bridge/frameLimits.js";
import { SNAPSHOT_MAX_SERIALIZED_BYTES } from "../../src/browser/snapshotSemantics.js";
import { OBSERVABILITY_MAX_SERIALIZED_BYTES } from "../../src/observability/observabilityPolicy.js";

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf-8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function registeredToolNames(): string[] {
  const require = createRequire(import.meta.url);
  void require;
  const files = [
    "src/server/tools/status.ts",
    "src/server/tools/tabs.ts",
    "src/server/tools/navigation.ts",
    "src/server/tools/snapshot.ts",
    "src/server/tools/interaction.ts",
    "src/server/tools/pageTools.ts",
    "src/server/tools/observability.ts",
  ];
  const names: string[] = [];
  for (const file of files) {
    const code = readSource(file);
    for (const match of code.matchAll(/"((?:browser|mcp)[a-z_]*)"/g)) {
      const name = match[1] ?? "";
      // Tool registration names are the quoted browser_* literals passed to
      // registerTool; schema titles/descriptions use different casing.
      if (name.startsWith("browser_")) {
        names.push(name);
      }
    }
  }
  return [...new Set(names)].sort();
}

/** Frozen public tool set: must not expand. */
export const FROZEN_PUBLIC_TOOLS = [
  "browser_click",
  "browser_close_tab",
  "browser_console",
  "browser_evaluate",
  "browser_fill",
  "browser_get_text",
  "browser_go_back",
  "browser_go_forward",
  "browser_list_tabs",
  "browser_navigate",
  "browser_network",
  "browser_open_tab",
  "browser_press_key",
  "browser_reload",
  "browser_screenshot",
  "browser_select_tab",
  "browser_snapshot",
  "browser_status",
  "browser_type",
  "browser_wait_for",
] as const;

describe("public tool set is frozen (no feature expansion)", () => {
  it("registers exactly the 20 approved tools and no more", () => {
    const actual = registeredToolNames();
    expect(actual).toEqual([...FROZEN_PUBLIC_TOOLS]);
    expect(actual).toHaveLength(20);
  });

  it("server.ts wires exactly the approved registrations", () => {
    const server = stripComments(readSource("src/server/server.ts"));
    for (const registration of [
      "registerStatusTool",
      "registerTabsTools",
      "registerNavigationTools",
      "registerSnapshotTool",
      "registerInteractionTools",
      "registerPageTools",
      "registerObservabilityTools",
    ]) {
      expect(server).toContain(registration);
    }
    expect(server).not.toMatch(/register\w*Tool\s*\(.*browser_/);
  });
});

describe("final static security audit", () => {
  it("forbids body/traversal CDP methods in production sources", () => {
    const productionFiles = [
      "extension/src/snapshot.ts",
      "extension/src/background.ts",
      "extension/src/tabs.ts",
      "extension/src/bridge.ts",
      "extension/src/diagnostics.ts",
      "src/browser/extension/ExtensionEngine.ts",
      "src/browser/extension/BridgeRuntime.ts",
      "src/browser/BrowserService.ts",
      "src/server/tools/observability.ts",
      "src/observability/ConsoleMonitor.ts",
      "src/observability/NetworkMonitor.ts",
      "src/security/Redaction.ts",
    ];
    // NOTE: snapshot.ts legitimately MENTIONS these tokens inside comments
    // that document the prohibition ("never used"). The architecture test
    // already strips comments; here we assert no actual CODE reference by
    // checking the comment-stripped source for call/member usage.
    for (const file of productionFiles) {
      const code = stripComments(readSource(file));
      for (const token of ["getResponseBody", "getRequestPostData", "getProperties", "callFunctionOn"]) {
        // Allow the two documented backstop scanners that name tokens to
        // detect leaks; forbid any other occurrence.
        if (file === "src/browser/snapshotSemantics.ts") {
          continue;
        }
        expect(code, `${file} must not reference ${token}`).not.toContain(token);
      }
    }
    // The leak scanner itself must keep watching for raw CDP keys.
    const semantics = readSource("src/browser/snapshotSemantics.ts");
    for (const key of ["backendNodeId", "objectId"]) {
      expect(semantics).toContain(key);
    }
  });

  it("forbids generic CDP/debugger-event bridges and control network listeners", () => {
    for (const file of [
      "extension/src/snapshot.ts",
      "extension/src/background.ts",
      "src/browser/extension/BridgeRuntime.ts",
      "src/bridge/mcpPipeServer.ts",
      "src/bridge/native-host/host.ts",
      "src/bridge/rpc.ts",
    ]) {
      const code = stripComments(readSource(file)).toLowerCase();
      for (const token of ["cdp.send", "debugger.command", "send_cdp", "debugger.event"]) {
        expect(code, `${file} must not contain ${token}`).not.toContain(token);
      }
    }
    // No TCP/HTTP/WebSocket control listener in production bridge sources.
    for (const file of [
      "src/bridge/mcpPipeServer.ts",
      "src/bridge/native-host/host.ts",
      "src/bridge/native-host/main.ts",
      "src/bridge/rpc.ts",
      "src/bridge/registry.ts",
      "src/bridge/cli.ts",
      "src/index.ts",
    ]) {
      let code = "";
      try {
        code = stripComments(readSource(file)).toLowerCase();
      } catch {
        continue;
      }
      expect(code, `${file} must not create TCP listeners`).not.toMatch(/\.listen\(\s*\d/);
      for (const token of ["express", "fastify", ".listen(80", ".listen(443", "websocketserver"]) {
        expect(code, `${file} must not contain ${token}`).not.toContain(token);
      }
    }
    const pipeServer = stripComments(readSource("src/bridge/mcpPipeServer.ts"));
    const listens = [...pipeServer.matchAll(/\.listen\(([^)]*)\)/g)].map((m) => m[1] ?? "");
    expect(listens.length).toBeGreaterThan(0);
    for (const args of listens) {
      expect(args).toMatch(/pipeName/);
    }
  });

  it("pins operation-scoped CDP capabilities (no broadening)", () => {
    const ext = stripComments(readSource("extension/src/snapshot.ts"));
    const capabilityBlock = ext.slice(ext.indexOf("CDP_CAPABILITY_METHODS"), ext.indexOf("export function createScopedCdpSender"));
    // Exactly the approved capability keys.
    for (const key of ["snapshot:", "interaction:", "evaluate:", "screenshot:", "wait:", '"observability-console":', '"observability-network":']) {
      expect(capabilityBlock).toContain(key);
    }
    // No new sensitive methods beyond the approved allowlist.
    for (const token of ["Page.enable", "Target.", "Storage.", "Browser.", "Network.set", "ExtraInfo", "DOM.getOuterHTML"]) {
      expect(ext, `extension must not contain ${token}`).not.toContain(token);
    }
  });

  it("keeps exactly one onRemoteRequest dispatcher", () => {
    const background = stripComments(readSource("extension/src/background.ts"));
    expect([...background.matchAll(/\.onRemoteRequest\s*\(/g)]).toHaveLength(1);
  });

  it("keeps manifest permissions minimal with no host permissions", () => {
    const manifest = JSON.parse(readSource("extension/manifest.json")) as { permissions?: unknown; host_permissions?: unknown };
    expect(manifest.permissions).toEqual(["debugger", "tabs", "storage", "nativeMessaging", "alarms"]);
    expect(manifest.host_permissions).toEqual([]);
  });

  it("pins native host identity: name, registry key, origin, and extension ID", () => {
    expect(NATIVE_HOST_NAME).toBe("com.BROWSER_mcp.bridge");
    expect(NATIVE_HOST_REGISTRY_KEY).toBe("HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.BROWSER_mcp.bridge");
    const identity = JSON.parse(readSource("extension/identity.json")) as { publicKey?: unknown };
    expect(typeof identity.publicKey).toBe("string");
    const id = extensionIdFromPublicKeyBase64(identity.publicKey as string);
    expect(id).toBe("hgipaclbbilhkpdbobokbgjfeafcbkpc");
    expect(extensionOrigin(id)).toBe("chrome-extension://hgipaclbbilhkpdbobokbgjfeafcbkpc/");
    // No private key material anywhere in the repo sources.
    for (const file of ["extension/identity.json", "src/bridge/extensionIdentity.ts", "src/bridge/hostManifest.ts"]) {
      expect(readSource(file).toLowerCase()).not.toContain("privatekey");
    }
  });

  it("pins all serialized/frame resource bounds", () => {
    expect(SMALL_FRAME_MAX_BYTES).toBe(262144);
    expect(LARGE_RESPONSE_FRAME_MAX_BYTES).toBe(16777216);
    expect(SCREENSHOT_MAX_DECODED_BYTES).toBe(8388608);
    expect(SNAPSHOT_MAX_SERIALIZED_BYTES).toBe(262144);
    expect(OBSERVABILITY_MAX_SERIALIZED_BYTES).toBe(524288);
  });

  it("fingerprint still covers every extension-consumed shared source", () => {
    const fingerprint = stripComments(readSource("extension/fingerprint.mjs"));
    for (const shared of [
      "src/browser/navigationPolicy",
      "src/browser/snapshotSemantics",
      "src/browser/interactionPolicy",
      "src/browser/pageToolsPolicy",
      "src/observability/observabilityPolicy",
      "src/observability/ConsoleMonitor",
      "src/observability/NetworkMonitor",
      "src/security/Redaction",
      "src/bridge/frameLimits",
    ]) {
      expect(fingerprint, `fingerprint must include ${shared}`).toContain(shared);
    }
  });
});
