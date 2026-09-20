import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import { NATIVE_HOST_NAME, NATIVE_HOST_REGISTRY_KEY } from "../src/bridge/constants.js";
import { renderHostLauncher, renderHostManifest } from "../src/bridge/hostManifest.js";
import {
  installHostRegistration,
  queryHostRegistration,
  uninstallHostRegistration,
} from "../src/bridge/registry.js";
import type { RegistryRunner } from "../src/bridge/registry.js";

function recordingRunner(responses: Map<string, { stdout: string }>): { runner: RegistryRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: RegistryRunner = (args: string[]) => {
    calls.push(args);
    const key = args.join("\u0000");
    const hit = responses.get(key);
    if (hit === undefined) {
      return Promise.reject(new Error("ERROR: The system was unable to find the specified registry key or value."));
    }
    return Promise.resolve({ stdout: hit.stdout, stderr: "" });
  };
  return { runner, calls };
}

describe("native host registration", () => {
  it("installs exactly the scoped host key with the manifest path", async () => {
    const expectedArgs = ["add", NATIVE_HOST_REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", "C:\\state\\com.arc_mcp.bridge.json", "/f"];
    const { runner, calls } = recordingRunner(new Map([[expectedArgs.join("\u0000"), { stdout: "" }]]));
    await installHostRegistration("C:\\state\\com.arc_mcp.bridge.json", runner);
    expect(calls).toEqual([expectedArgs]);
  });

  it("parses the registered manifest path from reg query output", async () => {
    const output = `\r\nHKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.arc_mcp.bridge\r\n    (Default)    REG_SZ    C:\\state\\com.arc_mcp.bridge.json\r\n`;
    const { runner } = recordingRunner(
      new Map([[["query", NATIVE_HOST_REGISTRY_KEY, "/ve"].join("\u0000"), { stdout: output }]]),
    );
    expect(await queryHostRegistration(runner)).toBe("C:\\state\\com.arc_mcp.bridge.json");
  });

  it("treats a missing key as null on query and success on uninstall", async () => {
    const { runner, calls } = recordingRunner(new Map());
    expect(await queryHostRegistration(runner)).toBeNull();
    await uninstallHostRegistration(runner);
    expect(calls[1]).toEqual(["delete", NATIVE_HOST_REGISTRY_KEY, "/f"]);
  });

  it("wraps runner failures as typed registry errors", async () => {
    const failing: RegistryRunner = () => Promise.reject(new Error("access denied"));
    let caught: unknown = null;
    try {
      await installHostRegistration("C:\\x.json", failing);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe("REGISTRY_ERROR");
  });
});

describe("native host manifest", () => {
  it("renders the exact allowed origin with a valid absolute launcher path", () => {
    const manifest = renderHostManifest(
      "C:\\Users\\x\\AppData\\Local\\arc-mcp\\native-host\\arc-mcp-native-host.cmd",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
    );
    expect(manifest.name).toBe(NATIVE_HOST_NAME);
    expect(manifest.type).toBe("stdio");
    expect(manifest.allowed_origins).toEqual(["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]);
    expect(() => JSON.parse(JSON.stringify(manifest))).not.toThrow();
  });

  it("refuses relative launcher paths and non-exact origins", () => {
    expect(() => renderHostManifest("relative\\host.cmd", "chrome-extension://abc/")).toThrow();
    expect(() => renderHostManifest("C:\\host.cmd", "chrome-extension://abc")).toThrow();
    expect(() => renderHostManifest("C:\\host.cmd", "*://*/")).toThrow();
  });

  it("renders a silent launcher that forwards Chrome arguments", () => {
    const launcher = renderHostLauncher("C:\\node\\node.exe", "C:\\app\\dist\\bridge\\native-host\\main.js");
    const lines = launcher.split("\r\n");
    expect(lines[0]).toBe("@echo off");
    expect(launcher).toContain('%*');
    expect(launcher).not.toMatch(/echo(?! off)/i);
  });
});
