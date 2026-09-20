import type { LogLevel } from "../utils/logger.js";
import { parseLogLevel } from "../utils/logger.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Minimal application configuration.
 *
 * profilePath is the explicit ARC_MCP_PROFILE_PATH override, or undefined
 * when unset. An undefined profilePath means "use the stable per-user
 * default" resolved by ArcProfile (LOCALAPPDATA-based, never CWD-relative),
 * so the MCP host may start arc-mcp from any working directory.
 */
export interface AppConfig {
  readonly debugPort: number;
  readonly profilePath: string | undefined;
  readonly arcExecutablePath: string | undefined;
  readonly allowedOrigins: readonly string[];
  readonly deniedOrigins: readonly string[];
  readonly allowEvaluate: boolean;
  readonly allowDownloads: boolean;
  readonly logLevel: LogLevel;
  readonly extensionConnectTimeoutMs: number;
  readonly consoleBufferEntries: number;
  readonly networkBufferEntries: number;
}

export const DEFAULT_DEBUG_PORT = 9222;
export const DEFAULT_LOG_LEVEL: LogLevel = "info";
export const DEFAULT_EXTENSION_CONNECT_TIMEOUT_MS = 120_000;
export const DEFAULT_CONSOLE_BUFFER_ENTRIES = 200;
export const DEFAULT_NETWORK_BUFFER_ENTRIES = 500;
export const MAX_CONSOLE_BUFFER_ENTRIES = 2000;
export const MAX_NETWORK_BUFFER_ENTRIES = 5000;

export function defaultConfig(): AppConfig {
  return {
    debugPort: DEFAULT_DEBUG_PORT,
    profilePath: undefined,
    arcExecutablePath: undefined,
    allowedOrigins: [],
    deniedOrigins: [],
    allowEvaluate: false,
    allowDownloads: false,
    logLevel: DEFAULT_LOG_LEVEL,
    extensionConnectTimeoutMs: DEFAULT_EXTENSION_CONNECT_TIMEOUT_MS,
    consoleBufferEntries: DEFAULT_CONSOLE_BUFFER_ENTRIES,
    networkBufferEntries: DEFAULT_NETWORK_BUFFER_ENTRIES,
  };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return DEFAULT_DEBUG_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ConfigError(`Invalid debug port: ${JSON.stringify(raw)}. Expected integer 1-65535.`);
  }
  return parsed;
}

function parsePositiveMs(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`Invalid ${name}: ${JSON.stringify(raw)}. Expected a positive integer of milliseconds.`);
  }
  return parsed;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  throw new ConfigError(`Invalid boolean value: ${JSON.stringify(raw)}. Expected true/false.`);
}

function parseStringList(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Finite bounded buffer capacity: positive integer within the hard max. */
function parseBufferEntries(raw: string | undefined, fallback: number, hardMax: number, name: string): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > hardMax) {
    throw new ConfigError(
      `Invalid ${name}: ${JSON.stringify(raw)}. Expected a positive integer 1-${String(hardMax)}.`,
    );
  }
  return parsed;
}

export type EnvLike = Record<string, string | undefined>;

export function loadConfig(env: EnvLike = process.env): AppConfig {
  const logLevelRaw = env["ARC_MCP_LOG_LEVEL"];
  const parsedLevel = logLevelRaw === undefined || logLevelRaw === "" ? DEFAULT_LOG_LEVEL : parseLogLevel(logLevelRaw);
  if (parsedLevel === undefined) {
    throw new ConfigError(
      `Invalid log level: ${JSON.stringify(logLevelRaw)}. Expected one of debug|info|warn|error.`,
    );
  }

  const profileRaw = env["ARC_MCP_PROFILE_PATH"]?.trim();
  const profilePath = profileRaw === undefined || profileRaw === "" ? undefined : profileRaw;

  // Canonical ARC_MCP_ARC_EXECUTABLE_PATH wins; ARC_MCP_EXECUTABLE_PATH
  // remains as a deprecated fallback alias.
  const executableRaw =
    env["ARC_MCP_ARC_EXECUTABLE_PATH"]?.trim() || env["ARC_MCP_EXECUTABLE_PATH"]?.trim();  const arcExecutablePath = executableRaw === undefined || executableRaw === "" ? undefined : executableRaw;

  return {
    debugPort: parsePort(env["ARC_MCP_DEBUG_PORT"]),
    profilePath,
    arcExecutablePath,
    allowedOrigins: parseStringList(env["ARC_MCP_ALLOWED_ORIGINS"]),
    deniedOrigins: parseStringList(env["ARC_MCP_DENIED_ORIGINS"]),
    allowEvaluate: parseBoolean(env["ARC_MCP_ALLOW_EVALUATE"], false),
    allowDownloads: parseBoolean(env["ARC_MCP_ALLOW_DOWNLOADS"], false),
    logLevel: parsedLevel,
    extensionConnectTimeoutMs: parsePositiveMs(
      env["ARC_MCP_EXTENSION_CONNECT_TIMEOUT_MS"],
      DEFAULT_EXTENSION_CONNECT_TIMEOUT_MS,
      "extension connect timeout",
    ),
    consoleBufferEntries: parseBufferEntries(
      env["ARC_MCP_CONSOLE_BUFFER_ENTRIES"],
      DEFAULT_CONSOLE_BUFFER_ENTRIES,
      MAX_CONSOLE_BUFFER_ENTRIES,
      "console buffer entries",
    ),
    networkBufferEntries: parseBufferEntries(
      env["ARC_MCP_NETWORK_BUFFER_ENTRIES"],
      DEFAULT_NETWORK_BUFFER_ENTRIES,
      MAX_NETWORK_BUFFER_ENTRIES,
      "network buffer entries",
    ),
  };
}
