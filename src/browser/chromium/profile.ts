import * as path from "node:path";
import { ConfigError } from "../../config/config.js";
import type { EnvLike } from "../../config/config.js";
import { unsafeProfilePath } from "../../errors/BrowserError.js";

/**
 * Dedicated MCP profile path logic.
 *
 * The MCP profile must live in a project-owned location, never inside a
 * browser's install tree, MSIX package data, or system directories. Paths
 * are normalized before every safety comparison, and comparisons are
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
    // MSIX package data (including browsers') must never host our profile.
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
 * Stable per-user default MCP profile directory for one browser.
 *
 * Primary: %LOCALAPPDATA%\arc-mcp\<profileDirName> (Windows). Fallback when
 * LOCALAPPDATA is unavailable: <USERPROFILE>\AppData\Local\arc-mcp\<name>
 * on Windows, ~/.arc-mcp/<name> elsewhere. Never CWD-relative: an MCP host
 * may start arc-mcp from any working directory. Throws a typed ConfigError
 * when no per-user base can be established.
 */
export function defaultMcpProfilePath(profileDirName: string, env: EnvLike = process.env): string {
  const localAppData = nonEmptyEnv(env["LOCALAPPDATA"]);
  if (localAppData !== null) {
    return path.join(localAppData, "arc-mcp", profileDirName);
  }
  if (process.platform === "win32") {
    const userProfile = nonEmptyEnv(env["USERPROFILE"]);
    if (userProfile !== null) {
      return path.join(userProfile, "AppData", "Local", "arc-mcp", profileDirName);
    }
  } else {
    const home = nonEmptyEnv(env["HOME"]);
    if (home !== null) {
      return path.join(home, ".arc-mcp", profileDirName);
    }
  }
  throw new ConfigError(
    "Cannot determine a per-user MCP profile directory (LOCALAPPDATA and user home are unavailable). Set ARC_MCP_PROFILE_PATH explicitly.",
  );
}

/**
 * Resolve the effective profile path: an explicit override is used verbatim
 * (and must still pass safety validation downstream); it is never rewritten
 * into the default. An absent override resolves to the stable default for
 * the given browser.
 */
export function resolveMcpProfilePath(
  explicitPath: string | undefined,
  profileDirName: string,
  env: EnvLike = process.env,
): string {
  if (explicitPath !== undefined && explicitPath.trim() !== "") {
    return path.resolve(explicitPath);
  }
  return defaultMcpProfilePath(profileDirName, env);
}

export interface ProfileSafetyOptions {
  /** Known browser install/package locations; the profile must avoid all. */
  readonly installDirs?: readonly string[];
}

/**
 * Throw a typed BROWSER_PROFILE_PATH_UNSAFE error when the target is a
 * filesystem root, a system/package location, or a browser-owned directory.
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
  for (const installDir of options.installDirs ?? []) {
    if (installDir.trim() !== "") {
      forbidden.push({ dir: installDir, label: "browser install/package location" });
    }
  }
  for (const entry of forbidden) {
    if (isSameOrInside(resolvedAbsolute, entry.dir)) {
      throw unsafeProfilePath(resolvedAbsolute, `profile path must not live inside ${entry.label} (${entry.dir})`);
    }
  }
}
