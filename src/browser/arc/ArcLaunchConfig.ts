import * as path from "node:path";
import { ConfigError } from "../../config/config.js";
import { assertSafeProfilePath, resolveProfilePath } from "./ArcProfile.js";

/**
 * Arc launch configuration builder (data only).
 *
 * P02 constructs and validates the configuration P03 will need; it never
 * spawns a process. Whether Arc accepts these arguments is P03's
 * verification job — this module makes no such claim.
 */

export interface ArcLaunchConfigInput {
  readonly executablePath: string;
  readonly profilePath: string;
  readonly debugPort: number;
  readonly extraArgs?: readonly string[];
  /** Known Arc install/package dirs; the profile must avoid them. */
  readonly arcInstallDirs?: readonly string[];
}

export interface ArcLaunchConfig {
  readonly executablePath: string;
  readonly profilePath: string;
  readonly debugPort: number;
  readonly args: readonly string[];
}

export function buildArcLaunchConfig(input: ArcLaunchConfigInput): ArcLaunchConfig {
  if (!Number.isInteger(input.debugPort) || input.debugPort < 1 || input.debugPort > 65535) {
    throw new ConfigError(`Invalid debug port: ${JSON.stringify(input.debugPort)}. Expected integer 1-65535.`);
  }
  const profilePath = resolveProfilePath(input.profilePath);
  const arcInstallDirs = [path.dirname(path.resolve(input.executablePath)), ...(input.arcInstallDirs ?? [])];
  assertSafeProfilePath(profilePath, { arcInstallDirs });
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
