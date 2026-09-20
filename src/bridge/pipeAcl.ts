import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type PipeAclRunner = (args: string[]) => Promise<{ stdout: string }>;

/**
 * Grant the Everyone ACE on an arc-mcp bridge pipe so a browser-launched
 * native host (restricted process token) can connect to the MCP-owned
 * listener. Node cannot set pipe security descriptors; this uses the
 * built-in set-pipe-acl.ps1 facility (kernel32/advapi32 only, no downloads).
 *
 * The ACE only opens transport: the 256-bit session nonce verified after
 * connect remains the real authentication. Namespace is validated here and
 * again inside the script.
 */
export function bridgePipeAclScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "scripts", "set-pipe-acl.ps1");
}

function defaultRunner(args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", args, { windowsHide: true, timeout: 30_000 }, (error, stdout) => {
      if (error instanceof Error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout) });
    });
  });
}

export async function applyBridgePipeAcl(
  pipeName: string,
  options: { scriptPath?: string; runner?: PipeAclRunner } = {},
): Promise<void> {
  if (!/^\\\\\.\\pipe\\arc-mcp-bridge-v1-[a-z0-9-]+$/.test(pipeName)) {
    throw new Error(`refusing pipe ACL outside the arc-mcp bridge namespace: ${pipeName}`);
  }
  const scriptPath = options.scriptPath ?? bridgePipeAclScript();
  const runner = options.runner ?? defaultRunner;
  try {
    await runner(["-NoProfile", "-NonInteractive", "-File", scriptPath, "-PipeName", pipeName]);
  } catch (error: unknown) {
    throw new Error(
      `failed to set bridge pipe ACL for ${pipeName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
