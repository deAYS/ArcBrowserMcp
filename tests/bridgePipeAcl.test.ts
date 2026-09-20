import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { applyBridgePipeAcl, bridgePipeAclScript } from "../src/bridge/pipeAcl.js";
import { McpPipeServer } from "../src/bridge/mcpPipeServer.js";

describe("bridge pipe ACL", () => {
  it("resolves to the committed script", () => {
    expect(bridgePipeAclScript().endsWith(`scripts${path.sep}set-pipe-acl.ps1`)).toBe(true);
  });

  it("refuses pipe names outside the bridge namespace", async () => {
    await expect(applyBridgePipeAcl("\\\\.\\pipe\\something-else")).rejects.toThrow();
    await expect(applyBridgePipeAcl("\\\\.\\pipe\\arc-mcp-bridge-v1-ok", {
      runner: (args) => {
        expect(args).toEqual([
          "-NoProfile",
          "-NonInteractive",
          "-File",
          expect.stringContaining("set-pipe-acl.ps1"),
          "-PipeName",
          "\\\\.\\pipe\\arc-mcp-bridge-v1-ok",
        ]);
        return Promise.resolve({ stdout: "pipe-acl-applied" });
      },
    })).resolves.toBeUndefined();
  });

  it("wraps runner failures with the pipe name", async () => {
    let caught: unknown = null;
    try {
      await applyBridgePipeAcl("\\\\.\\pipe\\arc-mcp-bridge-v1-ok", {
        runner: () => Promise.reject(new Error("powershell missing")),
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toContain("arc-mcp-bridge-v1-ok");
  });

  it("server start fails closed when the ACL step fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-acl-"));
    try {
      const server = new McpPipeServer({
        pipeName: `\\\\.\\pipe\\arc-mcp-bridge-v1-acl-fail-${String(process.pid)}`,
        sessionDir: dir,
        applyPipeAcl: () => Promise.reject(new Error("no powershell")),
      });
      await expect(server.start()).rejects.toThrow("no powershell");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
