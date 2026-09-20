import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { NATIVE_HOST_DESCRIPTION, NATIVE_HOST_NAME } from "./constants.js";

export interface GeneratedHostFiles {
  readonly manifestPath: string;
  readonly launcherPath: string;
}

export interface NativeHostManifest {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly type: "stdio";
  readonly allowed_origins: readonly [string];
}

/**
 * Render the native host manifest object. The absolute launcher path and
 * exact extension origin are supplied by the installer (per checkout), so
 * no machine-specific path is ever committed to a static source manifest.
 */
export function renderHostManifest(launcherPath: string, allowedOrigin: string): NativeHostManifest {
  if (!path.isAbsolute(launcherPath)) {
    throw new Error("native host launcher path must be absolute");
  }
  if (!allowedOrigin.startsWith("chrome-extension://") || !allowedOrigin.endsWith("/")) {
    throw new Error("allowed origin must be an exact chrome-extension://.../ origin");
  }
  return {
    name: NATIVE_HOST_NAME,
    description: NATIVE_HOST_DESCRIPTION,
    path: launcherPath,
    type: "stdio",
    allowed_origins: [allowedOrigin],
  };
}

/**
 * Render the tiny Windows launcher. It must write NOTHING to stdout (first
 * line disables echo) and forward Chrome's arguments verbatim to Node.
 */
export function renderHostLauncher(nodeExecutable: string, hostScript: string): string {
  if (!path.isAbsolute(nodeExecutable) || !path.isAbsolute(hostScript)) {
    throw new Error("launcher paths must be absolute");
  }
  return `@echo off\r\n"${nodeExecutable}" "${hostScript}" %*\r\n`;
}

export interface HostInstallLayout {
  readonly dir: string;
  readonly manifestPath: string;
  readonly launcherPath: string;
}

/** Installed layout beneath the per-user arc-mcp state directory. */
export function hostInstallLayout(stateDir: string): HostInstallLayout {
  const dir = path.join(stateDir, "native-host");
  return {
    dir,
    manifestPath: path.join(dir, `${NATIVE_HOST_NAME}.json`),
    launcherPath: path.join(dir, "arc-mcp-native-host.cmd"),
  };
}

/** Write the generated manifest + launcher (created by install, never committed). */
export async function writeHostFiles(
  layout: HostInstallLayout,
  manifest: NativeHostManifest,
  launcher: string,
): Promise<GeneratedHostFiles> {
  await mkdir(layout.dir, { recursive: true });
  await writeFile(layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  await writeFile(layout.launcherPath, launcher, "utf-8");
  return { manifestPath: layout.manifestPath, launcherPath: layout.launcherPath };
}
