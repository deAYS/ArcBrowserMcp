import * as path from "node:path";
import { ConfigError } from "../../config/config.js";
import { assertSafeProfilePath, resolveProfilePath } from "./profile.js";

/**
 * Chromium launch configuration builder (data only).
 *
 * Constructs and validates the configuration; it never
 * spawns a process. The flag set is standard Chromium and works for
 * Arc, Chrome, and future Chromium-based browsers alike.
 */

export interface ChromiumLaunchConfigInput {
  readonly executablePath: string;
  readonly profilePath: string;
  readonly debugPort: number;
  readonly extraArgs?: readonly string[];
  /** Known browser install/package dirs; the profile must avoid them. */
  readonly installDirs?: readonly string[];
}

export interface ChromiumLaunchConfig {
  readonly executablePath: string;
  readonly profilePath: string;
  readonly debugPort: number;
  readonly args: readonly string[];
}

export function buildChromiumLaunchConfig(input: ChromiumLaunchConfigInput): ChromiumLaunchConfig {
  if (!Number.isInteger(input.debugPort) || input.debugPort < 1 || input.debugPort > 65535) {
    throw new ConfigError(`Invalid debug port: ${JSON.stringify(input.debugPort)}. Expected integer 1-65535.`);
  }
  const profilePath = resolveProfilePath(input.profilePath);
  const installDirs = [path.dirname(path.resolve(input.executablePath)), ...(input.installDirs ?? [])];
  assertSafeProfilePath(profilePath, { installDirs });
  return {
    executablePath: path.resolve(input.executablePath),
    profilePath,
    debugPort: input.debugPort,
    args: [
      `--user-data-dir=${profilePath}`,
      `--remote-debugging-port=${String(input.debugPort)}`,
      "--remote-debugging-address=127.0.0.1",
      ...(input.extraArgs ?? []),
    ],
  };
}
