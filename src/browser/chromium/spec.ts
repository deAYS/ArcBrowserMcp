import * as path from "node:path";
import type { BrowserId, EnvLike } from "../../config/config.js";

/**
 * Per-browser data needed by the shared Chromium discovery/launch layer.
 *
 * Data only: no behavior lives here. Adding a browser means adding one
 * spec (plus, for Firefox, a native-messaging registry key constant
 * later). Nothing in this file may import discovery, launcher, or CDP.
 */
export interface BrowserSpec {
  readonly id: BrowserId;
  /** Human-readable name used in error messages and docs ("Google Chrome"). */
  readonly displayName: string;
  /** Executable file name that every discovered path must end with. */
  readonly executableBasename: string;
  /** Process-image name used by the running-process probe. */
  readonly processName: string;
  /** MSIX package name (Arc-style installs), or null when not applicable. */
  readonly appxPackageName: string | null;
  /** Install directories probed for the executable when other probes miss. */
  readonly installDirCandidates: readonly string[];
  /** Internal URL schemes additionally blocked from browser_open_tab. */
  readonly blockedCreateSchemes: readonly string[];
  /** Directory under the arc-mcp state dir holding the dedicated profile. */
  readonly profileDirName: string;
}

/** MSIX package identity for Arc on Windows. Never a filesystem path. */
export const ARC_PACKAGE_NAME = "TheBrowserCompany.Arc";

/** Arc spec: discovered via running process, MSIX package, or alias. */
export function arcSpec(_env: EnvLike = process.env): BrowserSpec {
  return {
    id: "arc",
    displayName: "Arc",
    executableBasename: "Arc.exe",
    processName: "Arc",
    appxPackageName: ARC_PACKAGE_NAME,
    installDirCandidates: [],
    blockedCreateSchemes: ["arc:"],
    // Historical name kept so existing Arc profiles are reused as-is.
    profileDirName: "profile",
  };
}

/** Chrome spec: discovered via running process or fixed install dirs. */
export function chromeSpec(env: EnvLike = process.env): BrowserSpec {
  const installDirs: string[] = [];
  for (const base of [
    env["ProgramFiles"],
    env["ProgramFiles(x86)"],
    env["LOCALAPPDATA"],
  ]) {
    if (base !== undefined && base !== "") {
      installDirs.push(path.join(base, "Google", "Chrome", "Application"));
    }
  }
  return {
    id: "chrome",
    displayName: "Google Chrome",
    executableBasename: "chrome.exe",
    processName: "chrome",
    appxPackageName: null,
    installDirCandidates: installDirs,
    blockedCreateSchemes: [],
    profileDirName: "profile-chrome",
  };
}

/** Resolve a browser id to its spec. Unknown ids are a caller bug. */
export function browserSpec(id: BrowserId, env: EnvLike = process.env): BrowserSpec {
  return id === "chrome" ? chromeSpec(env) : arcSpec(env);
}
