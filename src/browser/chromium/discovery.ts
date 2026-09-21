import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { BrowserSpec } from "./spec.js";
import { browserNotFound, invalidExecutablePath } from "../../errors/BrowserError.js";

export type DiscoverySource =
  | "explicit"
  | "running-process"
  | "appx-package"
  | "install-dir"
  | "execution-alias";

export interface DiscoveryResult {
  readonly executablePath: string;
  readonly source: DiscoverySource;
  readonly packageFullName?: string;
  readonly packageVersion?: string;
  readonly installLocation?: string;
}

export interface AppxPackageInfo {
  readonly name: string;
  readonly packageFullName: string;
  readonly installLocation: string;
  readonly version: string;
}

/** Finite bound for every OS/package probe. */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Seam for OS/package probes. The default implementation uses built-in Node
 * APIs; tests inject fakes so no test depends on a browser being installed.
 * Each probe is parameterized by data from the BrowserSpec, never by the
 * spec object itself.
 */
export interface DiscoveryProbes {
  /** True when path exists and is a regular file (follows reparse points). */
  isExecutableFile(candidatePath: string): Promise<boolean>;
  /** Installed MSIX package metadata, or null when absent/unreadable. */
  queryAppxPackage(packageName: string): Promise<AppxPackageInfo | null>;
  /** Executable paths of running processes with the given image name. */
  readRunningProcessPaths(processName: string): Promise<string[]>;
  /** Stable execution-alias candidates to check, in priority order. */
  executionAliasCandidates(executableBasename: string): string[];
}

export interface DiscoverOptions {
  readonly explicitPath?: string;
  readonly probes?: DiscoveryProbes;
}

function sameFileName(candidate: string, expected: string): boolean {
  return path.basename(candidate).toLowerCase() === expected.toLowerCase();
}

function resolveAbsolute(candidate: string): string {
  return path.resolve(candidate);
}

async function firstValidCandidate(
  candidates: readonly string[],
  executableBasename: string,
  probes: DiscoveryProbes,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = resolveAbsolute(candidate);
    const key = resolved.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (!sameFileName(resolved, executableBasename)) {
      continue;
    }
    if (await probes.isExecutableFile(resolved)) {
      return resolved;
    }
  }
  return null;
}

/** Probe failure must never crash discovery; fall through to later strategies. */
async function bestEffort<T>(action: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await action();
  } catch {
    return fallback;
  }
}

/** Interpolation guard for PowerShell probe scripts (fixed spec constants). */
function isSafeProbeToken(token: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(token);
}

/**
 * Discover the browser executable using ordered strategies without
 * launching it: explicit config > running-process image > MSIX package
 * metadata (when the spec has one) > install-dir candidates >
 * execution alias. Throws a typed BrowserError on invalid explicit config
 * or when every strategy is exhausted. Never spawns the browser itself.
 */
export async function discoverExecutable(
  spec: BrowserSpec,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const probes = options.probes ?? defaultProbes;
  const tried: string[] = [];

  const explicitRaw = options.explicitPath?.trim();
  if (explicitRaw !== undefined && explicitRaw !== "") {
    const resolved = resolveAbsolute(explicitRaw);
    if (!sameFileName(resolved, spec.executableBasename)) {
      throw invalidExecutablePath(
        spec.displayName,
        options.explicitPath ?? explicitRaw,
        `expected a file named ${spec.executableBasename}`,
      );
    }
    if (!(await probes.isExecutableFile(resolved))) {
      throw invalidExecutablePath(
        spec.displayName,
        options.explicitPath ?? explicitRaw,
        "path does not refer to an existing executable file",
      );
    }
    return { executablePath: resolved, source: "explicit" };
  }

  tried.push("running-process");
  const processPaths = await bestEffort(() => probes.readRunningProcessPaths(spec.processName), []);
  const fromProcess = await firstValidCandidate(processPaths, spec.executableBasename, probes);
  if (fromProcess !== null) {
    return { executablePath: fromProcess, source: "running-process" };
  }

  if (spec.appxPackageName !== null) {
    tried.push("appx-package");
    const appx = await bestEffort(() => probes.queryAppxPackage(spec.appxPackageName as string), null);
    if (appx !== null) {
      const candidate = path.join(appx.installLocation, spec.executableBasename);
      const validated = await firstValidCandidate([candidate], spec.executableBasename, probes);
      if (validated !== null) {
        return {
          executablePath: validated,
          source: "appx-package",
          packageFullName: appx.packageFullName,
          packageVersion: appx.version,
          installLocation: appx.installLocation,
        };
      }
    }
  }

  if (spec.installDirCandidates.length > 0) {
    tried.push("install-dir");
    const fromInstallDir = await firstValidCandidate(
      spec.installDirCandidates.map((dir) => path.join(dir, spec.executableBasename)),
      spec.executableBasename,
      probes,
    );
    if (fromInstallDir !== null) {
      return { executablePath: fromInstallDir, source: "install-dir" };
    }
  }

  tried.push("execution-alias");
  const alias = await firstValidCandidate(
    probes.executionAliasCandidates(spec.executableBasename),
    spec.executableBasename,
    probes,
  );
  if (alias !== null) {
    return { executablePath: alias, source: "execution-alias" };
  }

  throw browserNotFound(spec.displayName, tried);
}

function runPowerShellJson(script: string): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error instanceof Error) {
          reject(error);
          return;
        }
        try {
          const trimmed = stdout.trim();
          resolve(trimmed === "" ? null : (JSON.parse(trimmed) as unknown));
        } catch (parseError) {
          reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
        }
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function toAppxInfo(value: unknown, packageName: string): AppxPackageInfo | null {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const installLocation = nonEmptyString(entry["InstallLocation"]);
    if (installLocation === null) {
      continue;
    }
    return {
      name: nonEmptyString(entry["Name"]) ?? packageName,
      packageFullName: nonEmptyString(entry["PackageFullName"]) ?? packageName,
      installLocation,
      version: nonEmptyString(entry["Version"]) ?? "unknown",
    };
  }
  return null;
}

async function defaultIsExecutableFile(candidatePath: string): Promise<boolean> {
  try {
    return (await fs.stat(candidatePath)).isFile();
  } catch {
    // Missing, inaccessible, or otherwise unusable: not a valid candidate.
    return false;
  }
}

async function defaultQueryAppxPackage(packageName: string): Promise<AppxPackageInfo | null> {
  // Interpolation guard above; callers pass fixed spec constants.
  if (!isSafeProbeToken(packageName)) {
    return null;
  }
  const script = `Get-AppxPackage -Name '${packageName}' | Select-Object Name, PackageFullName, InstallLocation, Version | ConvertTo-Json -Compress -Depth 3`;
  const parsed = await runPowerShellJson(script);
  return toAppxInfo(parsed, packageName);
}

async function defaultReadRunningProcessPaths(processName: string): Promise<string[]> {
  // Read-only inspection of process image paths; never attaches or signals.
  if (!isSafeProbeToken(processName)) {
    return [];
  }
  const script = `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path`;
  const parsed: unknown = await new Promise<unknown>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error instanceof Error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
  if (typeof parsed !== "string") {
    return [];
  }
  return parsed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function defaultExecutionAliasCandidates(executableBasename: string): string[] {
  const localAppData = process.env["LOCALAPPDATA"];
  if (localAppData === undefined || localAppData === "") {
    return [];
  }
  return [path.join(localAppData, "Microsoft", "WindowsApps", executableBasename)];
}

export const defaultProbes: DiscoveryProbes = {
  isExecutableFile: defaultIsExecutableFile,
  queryAppxPackage: defaultQueryAppxPackage,
  readRunningProcessPaths: defaultReadRunningProcessPaths,
  executionAliasCandidates: defaultExecutionAliasCandidates,
};
