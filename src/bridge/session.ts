import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { BridgeError } from "./BridgeError.js";
import type { EnvLike } from "../config/config.js";

/**
 * Bridge session descriptor: the rendezvous record between one MCP process
 * (pipe owner) and the browser-launched native host.
 *
 * Lives beneath the per-user arc-mcp state directory (never CWD, never the
 * browser profile). Contains no browser credentials: pipe name, a 256-bit
 * session nonce, owner PID, and creation metadata. Written atomically and
 * removed on clean shutdown; staleness is decided by owner-process liveness,
 * never by blind trust.
 */

export const BRIDGE_SESSION_VERSION = 1;
export const SESSION_NONCE_BYTES = 32;
export const BRIDGE_SESSION_FILE_NAME = "bridge-session.json";

export interface BridgeSession {
  readonly version: 1;
  readonly pipeName: string;
  readonly nonceHex: string;
  readonly mcpPid: number;
  readonly createdAt: string;
}

export function defaultSessionDir(env: EnvLike = process.env): string {
  const localAppData = env["LOCALAPPDATA"];
  if (localAppData === undefined || localAppData.trim() === "") {
    throw new BridgeError("SESSION_MISSING", "LOCALAPPDATA is unavailable; cannot locate the bridge session directory");
  }
  return `${localAppData}\\arc-mcp\\sessions`;
}

export function createSession(pipeName: string, mcpPid: number): BridgeSession {
  return {
    version: 1,
    pipeName,
    nonceHex: randomBytes(SESSION_NONCE_BYTES).toString("hex"),
    mcpPid,
    createdAt: new Date().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseSessionDescriptor(raw: string): BridgeSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new BridgeError("SESSION_CORRUPT", "bridge session file is not valid JSON", {}, error);
  }
  if (!isRecord(parsed) || parsed["version"] !== BRIDGE_SESSION_VERSION) {
    throw new BridgeError("SESSION_CORRUPT", "bridge session file has an unsupported version");
  }
  if (
    typeof parsed["pipeName"] !== "string" ||
    parsed["pipeName"] === "" ||
    typeof parsed["nonceHex"] !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed["nonceHex"]) ||
    typeof parsed["mcpPid"] !== "number" ||
    !Number.isInteger(parsed["mcpPid"]) ||
    typeof parsed["createdAt"] !== "string"
  ) {
    throw new BridgeError("SESSION_CORRUPT", "bridge session file has invalid fields");
  }
  return {
    version: 1,
    pipeName: parsed["pipeName"],
    nonceHex: parsed["nonceHex"],
    mcpPid: parsed["mcpPid"],
    createdAt: parsed["createdAt"],
  };
}

/** Null when absent; typed error when present but corrupt. */
export async function loadSessionDescriptor(
  readFile: (path: string) => Promise<string>,
  sessionPath: string,
): Promise<BridgeSession | null> {
  try {
    return parseSessionDescriptor(await readFile(sessionPath));
  } catch (error: unknown) {
    if (isRecord(error) && (error as { code?: unknown }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Obviously stale when the owner PID is no longer alive. */
export function isSessionStale(session: BridgeSession, isPidAlive: (pid: number) => boolean): boolean {
  try {
    return !isPidAlive(session.mcpPid);
  } catch {
    return true;
  }
}

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // ESRCH: no such process (obviously stale). EPERM: the process EXISTS
    // but is unqueryable from here — notably when a browser-launched native
    // host runs under Chrome's restricted token. EPERM must never read as
    // stale, or every browser-spawned host would reject a live MCP session.
    return (error as { code?: unknown }).code === "EPERM";
  }
}

export async function writeSessionAtomic(sessionPath: string, session: BridgeSession): Promise<void> {
  const tempPath = `${sessionPath}.${String(process.pid)}.tmp`;
  await writeFile(tempPath, JSON.stringify(session), "utf-8");
  await rename(tempPath, sessionPath);
}

export async function removeSessionFile(sessionPath: string): Promise<void> {
  await rm(sessionPath, { force: true });
}
