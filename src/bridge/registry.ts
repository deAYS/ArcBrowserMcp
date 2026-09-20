import { execFile } from "node:child_process";
import { BridgeError } from "./BridgeError.js";
import { NATIVE_HOST_REGISTRY_KEY } from "./constants.js";

/**
 * Per-user (HKCU) Native Messaging host registration via reg.exe.
 *
 * All operations are scoped to the single fixed host key: any attempt to
 * address another key is refused before a process is spawned. reg.exe is a
 * built-in OS facility invoked with fixed argv (no shell, no user input in
 * the command line beyond the manifest path value).
 */

const REGISTRY_SCOPE_PREFIX = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\";

export type RegistryRunner = (
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

function defaultRunner(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("reg.exe", args, { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error instanceof Error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function assertScopedKey(key: string): void {
  if (key !== NATIVE_HOST_REGISTRY_KEY || !key.startsWith(REGISTRY_SCOPE_PREFIX)) {
    throw new BridgeError("REGISTRY_ERROR", "refusing to touch a registry key outside the bridge host scope");
  }
}

function wrapRegistryError(action: string, error: unknown): BridgeError {
  return new BridgeError("REGISTRY_ERROR", `registry ${action} failed for the bridge host key`, {}, error);
}

/** Install/update the exact host key pointing at the generated manifest. */
export async function installHostRegistration(
  manifestPath: string,
  runner: RegistryRunner = defaultRunner,
): Promise<void> {
  assertScopedKey(NATIVE_HOST_REGISTRY_KEY);
  try {
    await runner(["add", NATIVE_HOST_REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
  } catch (error: unknown) {
    throw wrapRegistryError("install", error);
  }
}

/** Remove exactly the host key. Missing keys are success (idempotent). */
export async function uninstallHostRegistration(runner: RegistryRunner = defaultRunner): Promise<void> {
  assertScopedKey(NATIVE_HOST_REGISTRY_KEY);
  try {
    await runner(["delete", NATIVE_HOST_REGISTRY_KEY, "/f"]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("was not found") || message.includes("ERROR: The system was unable to find")) {
      return;
    }
    throw wrapRegistryError("uninstall", error);
  }
}

/** Read the manifest path registered under the exact host key, or null. */
export async function queryHostRegistration(runner: RegistryRunner = defaultRunner): Promise<string | null> {
  assertScopedKey(NATIVE_HOST_REGISTRY_KEY);
  let stdout: string;
  try {
    ({ stdout } = await runner(["query", NATIVE_HOST_REGISTRY_KEY, "/ve"]));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("was not found") || message.includes("ERROR: The system was unable to find")) {
      return null;
    }
    throw wrapRegistryError("query", error);
  }
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*\(Default\)\s+REG_SZ\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}
