import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { arcNotFound, invalidArcExecutablePath } from "../../errors/ArcError.js";

export type ArcDiscoverySource = "explicit" | "running-process" | "appx-package" | "execution-alias";

export interface ArcDiscoveryResult {
  readonly executablePath: string;
  readonly source: ArcDiscoverySource;
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

/** MSIX package identity for Arc on Windows. Never a filesystem path. */
export const ARC_PACKAGE_NAME = "TheBrowserCompany.Arc";
export const ARC_EXECUTABLE_BASENAME = "Arc.exe";
/** Finite bound for every OS/package probe. */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Seam for OS/package probes. The default implementation uses built-in Node
 * APIs; tests inject fakes so no test depends on Arc being installed.
 */
export interface DiscoveryProbes {
  /** True when path exists and is a regular file (follows reparse points). */
  isExecutableFile(candidatePath: string): Promise<boolean>;
  /** Installed Arc MSIX package metadata, or null when absent/unreadable. */
  queryAppxPackage(): Promise<AppxPackageInfo | null>;
  /** Executable paths of running Arc processes (best effort, read-only). */
  readRunningArcPaths(): Promise<string[]>;
  /** Stable execution-alias candidates to check, in priority order. */
  executionAliasCandidates(): string[];
}

export interface DiscoverArcOptions {
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
    if (!sameFileName(resolved, ARC_EXECUTABLE_BASENAME)) {
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

/**
 * Discover the Arc executable using ordered strategies without launching it:
 * explicit config > running-process image > MSIX package metadata >
 * execution alias. Throws typed ArcError on invalid explicit config or when
 * every strategy is exhausted. Never spawns Arc itself.
 */
export async function discoverArcExecutable(options: DiscoverArcOptions = {}): Promise<ArcDiscoveryResult> {
  const probes = options.probes ?? defaultProbes;
  const tried: string[] = [];

  const explicitRaw = options.explicitPath?.trim();
  if (explicitRaw !== undefined && explicitRaw !== "") {
    const resolved = resolveAbsolute(explicitRaw);
    if (!sameFileName(resolved, ARC_EXECUTABLE_BASENAME)) {
      throw invalidArcExecutablePath(
        options.explicitPath ?? explicitRaw,
        `expected a file named ${ARC_EXECUTABLE_BASENAME}`,
      );
    }
    if (!(await probes.isExecutableFile(resolved))) {
      throw invalidArcExecutablePath(
        options.explicitPath ?? explicitRaw,
        "path does not refer to an existing executable file",
      );
    }
    return { executablePath: resolved, source: "explicit" };
  }

  tried.push("running-process");
  const processPaths = await bestEffort(() => probes.readRunningArcPaths(), []);
  const fromProcess = await firstValidCandidate(processPaths, probes);
  if (fromProcess !== null) {
    return { executablePath: fromProcess, source: "running-process" };
  }

  tried.push("appx-package");
  const appx = await bestEffort(() => probes.queryAppxPackage(), null);
  if (appx !== null) {
    const candidate = path.join(appx.installLocation, ARC_EXECUTABLE_BASENAME);
    const validated = await firstValidCandidate([candidate], probes);
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

  tried.push("execution-alias");
  const alias = await firstValidCandidate(probes.executionAliasCandidates(), probes);
  if (alias !== null) {
    return { executablePath: alias, source: "execution-alias" };
  }

  throw arcNotFound(tried);
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

function toAppxInfo(value: unknown): AppxPackageInfo | null {
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
      name: nonEmptyString(entry["Name"]) ?? ARC_PACKAGE_NAME,
      packageFullName: nonEmptyString(entry["PackageFullName"]) ?? ARC_PACKAGE_NAME,
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

async function defaultQueryAppxPackage(): Promise<AppxPackageInfo | null> {
  // Fixed script; package name is a constant, no user input is interpolated.
  const script = `Get-AppxPackage -Name '${ARC_PACKAGE_NAME}' | Select-Object Name, PackageFullName, InstallLocation, Version | ConvertTo-Json -Compress -Depth 3`;
  const parsed = await runPowerShellJson(script);
  return toAppxInfo(parsed);
}

async function defaultReadRunningArcPaths(): Promise<string[]> {
  // Read-only inspection of process image paths; never attaches or signals.
  const script = `Get-Process -Name 'Arc' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path`;
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

function defaultExecutionAliasCandidates(): string[] {
  const localAppData = process.env["LOCALAPPDATA"];
  if (localAppData === undefined || localAppData === "") {
    return [];
  }
  return [path.join(localAppData, "Microsoft", "WindowsApps", ARC_EXECUTABLE_BASENAME)];
}

export const defaultProbes: DiscoveryProbes = {
  isExecutableFile: defaultIsExecutableFile,
  queryAppxPackage: defaultQueryAppxPackage,
  readRunningArcPaths: defaultReadRunningArcPaths,
  executionAliasCandidates: defaultExecutionAliasCandidates,
};
