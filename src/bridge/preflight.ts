import { existsSync } from "node:fs";
import { readFile as readFileUtf8 } from "node:fs/promises";
import { NATIVE_HOST_NAME } from "./constants.js";
import { hostInstallLayout } from "./hostManifest.js";
import { queryHostRegistration } from "./registry.js";
import { arcMcpStateDir } from "./constants.js";

export interface PrerequisiteIssue {
  readonly code: string;
  readonly remediation: string;
}

export interface PreflightDeps {
  readonly stateDir?: string;
  readonly expectedOrigin?: string;
  readonly fileExists?: (path: string) => boolean;
  readonly readManifestFile?: (path: string) => Promise<string>;
  readonly queryRegistry?: () => Promise<string | null>;
}

/**
 * Read-only setup validation for the extension bridge (no mutation).
 * Checks the generated host manifest, its launcher path, the exact
 * allowed origin, and the HKCU registry mapping. Installation/repair
 * belongs to setup (pnpm bridge:install), never to engine connect().
 */
export async function checkBridgePrerequisites(deps: PreflightDeps = {}): Promise<PrerequisiteIssue[]> {
  const issues: PrerequisiteIssue[] = [];
  const expectedOrigin = deps.expectedOrigin;
  if (expectedOrigin === undefined || expectedOrigin === "") {
    issues.push({
      code: "BRIDGE_PREFLIGHT_FAILED",
      remediation: "deterministic extension origin is not configured; cannot validate the bridge setup",
    });
    return issues;
  }
  let stateDir: string;
  try {
    stateDir = deps.stateDir ?? arcMcpStateDir();
  } catch {
    issues.push({
      code: "BRIDGE_PREFLIGHT_FAILED",
      remediation: "LOCALAPPDATA is unavailable; cannot locate the per-user bridge state",
    });
    return issues;
  }
  const layout = hostInstallLayout(stateDir);
  const exists = deps.fileExists ?? existsSync;
  if (!exists(layout.manifestPath)) {
    issues.push({
      code: "BRIDGE_PREFLIGHT_FAILED",
      remediation: `native host manifest missing at ${layout.manifestPath}; run pnpm bridge:install`,
    });
    return issues;
  }
  const readManifestText = deps.readManifestFile ?? ((filePath: string) => readFileUtf8(filePath, "utf-8"));
  let manifest: { allowed_origins?: unknown; path?: unknown; name?: unknown };
  try {
    manifest = JSON.parse(await readManifestText(layout.manifestPath)) as {
      allowed_origins?: unknown;
      path?: unknown;
      name?: unknown;
    };
  } catch {
    issues.push({
      code: "BRIDGE_PREFLIGHT_FAILED",
      remediation: `native host manifest at ${layout.manifestPath} is not valid JSON; run pnpm bridge:install`,
    });
    return issues;
  }
  if (manifest.name !== NATIVE_HOST_NAME) {
    issues.push({
      code: "BRIDGE_PREFLIGHT_FAILED",
      remediation: `native host manifest name must be ${NATIVE_HOST_NAME}; run pnpm bridge:install`,
    });
  }
  const origins = manifest.allowed_origins;
  if (!Array.isArray(origins) || origins.length !== 1 || origins[0] !== expectedOrigin) {
    issues.push({
      code: "BRIDGE_PREFLIGHT_FAILED",
      remediation: `native host manifest must allow exactly ${expectedOrigin}; run pnpm bridge:install`,
    });
  }
  if (typeof manifest.path !== "string" || manifest.path === "" || !exists(manifest.path)) {
    issues.push({
      code: "BRIDGE_PREFLIGHT_FAILED",
      remediation: "native host launcher is missing; run pnpm bridge:install",
    });
  }
  const query = deps.queryRegistry ?? (() => queryHostRegistration());
  let registered: string | null;
  try {
    registered = await query();
  } catch {
    issues.push({
      code: "BRIDGE_PREFLIGHT_FAILED",
      remediation: "native host registry lookup failed; run pnpm bridge:check for details",
    });
    return issues;
  }
  if (registered !== layout.manifestPath) {
    issues.push({
      code: "BRIDGE_PREFLIGHT_FAILED",
      remediation: "native host registry mapping missing or stale; run pnpm bridge:install",
    });
  }
  return issues;
}
