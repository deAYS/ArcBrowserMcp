import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkBridgePrerequisites } from "../src/bridge/preflight.js";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-preflight-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("bridge preflight checks", () => {
  it("reports a missing manifest with install remediation", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const issues = await checkBridgePrerequisites({
        stateDir: dir,
        expectedOrigin: ORIGIN,
        queryRegistry: () => Promise.resolve(null),
      });
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]?.remediation ?? "").toContain("pnpm bridge:install");
    } finally {
      await cleanup();
    }
  });

  it("passes a correct installation", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const { mkdir } = await import("node:fs/promises");
      const hostDir = path.join(dir, "native-host");
      await mkdir(hostDir, { recursive: true });
      const launcher = path.join(hostDir, "arc-mcp-native-host.cmd");
      await writeFile(launcher, "@echo off\r\n", "utf-8");
      const manifestPath = path.join(hostDir, "com.arc_mcp.bridge.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          name: "com.arc_mcp.bridge",
          description: "x",
          path: launcher,
          type: "stdio",
          allowed_origins: [ORIGIN],
        }),
        "utf-8",
      );
      const issues = await checkBridgePrerequisites({
        stateDir: dir,
        expectedOrigin: ORIGIN,
        queryRegistry: () => Promise.resolve(manifestPath),
      });
      expect(issues).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("flags wrong origin, missing launcher, and registry mismatch", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const { mkdir } = await import("node:fs/promises");
      const hostDir = path.join(dir, "native-host");
      await mkdir(hostDir, { recursive: true });
      const manifestPath = path.join(hostDir, "com.arc_mcp.bridge.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          name: "com.arc_mcp.bridge",
          description: "x",
          path: path.join(hostDir, "missing.cmd"),
          type: "stdio",
          allowed_origins: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"],
        }),
        "utf-8",
      );
      const issues = await checkBridgePrerequisites({
        stateDir: dir,
        expectedOrigin: ORIGIN,
        queryRegistry: () => Promise.resolve("C:\\elsewhere\\manifest.json"),
      });
      const codes = issues.map((issue) => issue.code);
      expect(codes.length).toBeGreaterThanOrEqual(3);
      expect(new Set(codes)).toEqual(new Set(["BRIDGE_PREFLIGHT_FAILED"]));
      for (const issue of issues) {
        expect(issue.remediation).toContain("pnpm bridge:install");
      }
    } finally {
      await cleanup();
    }
  });

  it("rejects malformed manifest JSON", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const { mkdir } = await import("node:fs/promises");
      const hostDir = path.join(dir, "native-host");
      await mkdir(hostDir, { recursive: true });
      await writeFile(path.join(hostDir, "com.arc_mcp.bridge.json"), "{oops", "utf-8");
      const issues = await checkBridgePrerequisites({
        stateDir: dir,
        expectedOrigin: ORIGIN,
        queryRegistry: () => Promise.resolve(null),
      });
      expect(issues.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});
