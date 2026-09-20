import * as path from "node:path";
import { ConfigError } from "../../config/config.js";
import type { EnvLike } from "../../config/config.js";
import { unsafeProfilePath } from "../../errors/ArcError.js";

/**
 * Dedicated MCP profile path logic.
 *
 * The MCP profile must live in a project-owned location, never inside Arc's
 * install tree, MSIX package data, or system directories. Paths are
 * normalized before every safety comparison, and comparisons are
 * case-insensitive on Windows.
 */

function normalizeForCompare(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(candidate: string, root: string): boolean {
  const c = normalizeForCompare(candidate);
  const r = normalizeForCompare(root);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

function windowsSystemRoots(): string[] {
  const roots: string[] = [];
  const windir = process.env["SystemRoot"] ?? process.env["WINDIR"];
  if (windir !== undefined && windir !== "") {
    roots.push(windir);
  }
  for (const key of ["ProgramFiles", "ProgramFiles(x86)"]) {
    const dir = process.env[key];
    if (dir !== undefined && dir !== "") {
      roots.push(dir);
    }
  }
  const localAppData = process.env["LOCALAPPDATA"];
  if (localAppData !== undefined && localAppData !== "") {
    // MSIX package data (including Arc's) must never host our profile.
    roots.push(path.join(localAppData, "Packages"));
  }
  return roots;
}

/** Resolve a configured profile path to an absolute normalized path. */
export function resolveProfilePath(configuredPath: string): string {
  return path.resolve(configuredPath);
}

function nonEmptyEnv(value: string | undefined): string | null {
  return value !== undefined && value.trim() !== "" ? value : null;
}

/**
 * Stable per-user default MCP profile directory.
 *
 * Primary: %LOCALAPPDATA%\arc-mcp\profile (Windows). Fallback when
 * LOCALAPPDATA is unavailable: <USERPROFILE>\AppData\Local\arc-mcp\profile
 * on Windows, ~/.arc-mcp/profile elsewhere. Never CWD-relative: an MCP host
 * may start arc-mcp from any working directory. Throws a typed ConfigError
 * when no per-user base can be established.
 */
export function defaultMcpProfilePath(env: EnvLike = process.env): string {
  const localAppData = nonEmptyEnv(env["LOCALAPPDATA"]);
  if (localAppData !== null) {
    return path.join(localAppData, "arc-mcp", "profile");
  }
  if (process.platform === "win32") {
    const userProfile = nonEmptyEnv(env["USERPROFILE"]);
    if (userProfile !== null) {
      return path.join(userProfile, "AppData", "Local", "arc-mcp", "profile");
    }
  } else {
    const home = nonEmptyEnv(env["HOME"]);
    if (home !== null) {
      return path.join(home, ".arc-mcp", "profile");
    }
  }
  throw new ConfigError(
    "Cannot determine a per-user MCP profile directory (LOCALAPPDATA and user home are unavailable). Set ARC_MCP_PROFILE_PATH explicitly.",
  );
}

/**
 * Resolve the effective profile path: an explicit override is used verbatim
 * (and must still pass safety validation downstream); it is never rewritten
 * into the default. An absent override resolves to the stable default.
 */
export function resolveMcpProfilePath(
  explicitPath: string | undefined,
  env: EnvLike = process.env,
): string {
  if (explicitPath !== undefined && explicitPath.trim() !== "") {
    return path.resolve(explicitPath);
  }
  return defaultMcpProfilePath(env);
}

export interface ProfileSafetyOptions {
  /** Known Arc install/package locations; the profile must avoid all of them. */
  readonly arcInstallDirs?: readonly string[];
}

/**
 * Throw a typed ARC_PROFILE_PATH_UNSAFE error when the target is a
 * filesystem root, a system/package location, or an Arc-owned directory.
 */
export function assertSafeProfilePath(resolvedAbsolute: string, options: ProfileSafetyOptions = {}): void {
  if (!path.isAbsolute(resolvedAbsolute)) {
    throw unsafeProfilePath(resolvedAbsolute, "profile path must be absolute");
  }
  const root = path.parse(resolvedAbsolute).root;
  if (normalizeForCompare(resolvedAbsolute) === normalizeForCompare(root)) {
    throw unsafeProfilePath(resolvedAbsolute, "profile path must not be a filesystem root");
  }
  const forbidden: Array<{ dir: string; label: string }> = windowsSystemRoots().map((dir) => ({
    dir,
    label: "system or package location",
  }));
  for (const installDir of options.arcInstallDirs ?? []) {
    if (installDir.trim() !== "") {
      forbidden.push({ dir: installDir, label: "Arc install/package location" });
    }
  }
  for (const entry of forbidden) {
    if (isSameOrInside(resolvedAbsolute, entry.dir)) {
      throw unsafeProfilePath(resolvedAbsolute, `profile path must not live inside ${entry.label} (${entry.dir})`);
    }
  }
}
