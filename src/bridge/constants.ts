/**
 * Shared bridge constants: single source for host name, pipe namespace,
 * and registry locations so install/check/host/extension can never drift.
 *
 * The host name, pipe namespace, and state directory keep the historical
 * `arc-mcp` identity: renaming them would invalidate every existing
 * install. Per-browser data lives in src/browser/chromium/spec.ts.
 */

export const NATIVE_HOST_NAME = "com.arc_mcp.bridge";
export const NATIVE_HOST_DESCRIPTION = "arc-mcp Native Messaging Bridge";

/**
 * HKCU vendor path for Chromium-compatible native host registration.
 * Chromium browsers (Arc, Chrome, ...) share the Google\Chrome key, so one
 * registration serves them all. Firefox later needs Software\Mozilla.
 */
export const NATIVE_HOST_REGISTRY_KEY =
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.arc_mcp.bridge";

const PIPE_NAMESPACE = "arc-mcp-bridge-v1";

function sanitizePipeSegment(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "default" : cleaned.slice(0, 32);
}

/** Per-user pipe name: one active MCP owner per Windows user. */
export function bridgePipeName(username?: string): string {
  return `\\\\.\\pipe\\${PIPE_NAMESPACE}-${sanitizePipeSegment(username ?? "default")}`;
}

/** Per-user arc-mcp state directory (never CWD, never the browser profile). */
export function arcMcpStateDir(localAppData?: string): string {
  const base = localAppData ?? process.env["LOCALAPPDATA"] ?? "";
  if (base.trim() === "") {
    throw new Error("LOCALAPPDATA is unavailable; cannot locate the arc-mcp state directory");
  }
  return `${base}\\arc-mcp`;
}
