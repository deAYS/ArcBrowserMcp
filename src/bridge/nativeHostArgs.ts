import { timingSafeEqual } from "node:crypto";
import { BridgeError } from "./BridgeError.js";

/**
 * Native host argument parsing and caller-origin validation.
 *
 * Chrome launches the host as: <host> <extension-origin> [--parent-window=N].
 * The origin argument is located by shape (never by position alone), the
 * parent-window argument is recognized and ignored, and anything else is
 * rejected: an unknown caller context must fail closed.
 */

const ORIGIN_PREFIX = "chrome-extension://";
const PARENT_WINDOW_PREFIX = "--parent-window=";

export interface ParsedHostArgs {
  readonly origin: string;
  readonly parentWindow: string | null;
}

/** Constant-time string comparison (length mismatch short-circuits). */
export function safeEqualString(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf-8");
  const rightBytes = Buffer.from(right, "utf-8");
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function normalizeOrigin(origin: string): string {
  return origin.endsWith("/") ? origin : `${origin}/`;
}

export function parseNativeHostArgs(argv: string[], expectedOrigin: string): ParsedHostArgs {
  const origins: string[] = [];
  let parentWindow: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith(ORIGIN_PREFIX)) {
      origins.push(arg);
    } else if (arg.startsWith(PARENT_WINDOW_PREFIX)) {
      parentWindow = arg.slice(PARENT_WINDOW_PREFIX.length);
    } else if (arg.trim() !== "") {
      throw new BridgeError(
        "ORIGIN_REJECTED",
        `refusing to run with unrecognized native host argument ${JSON.stringify(arg)}`,
      );
    }
  }
  if (origins.length === 0) {
    throw new BridgeError("ORIGIN_REJECTED", "native host started without an extension origin argument");
  }
  const distinct = [...new Set(origins.map(normalizeOrigin))];
  if (distinct.length > 1) {
    throw new BridgeError("ORIGIN_REJECTED", "native host started with multiple distinct origins");
  }
  const origin = normalizeOrigin(origins[0] ?? "");
  if (!safeEqualString(origin, normalizeOrigin(expectedOrigin))) {
    throw new BridgeError("ORIGIN_REJECTED", "extension origin does not match the expected bridge extension");
  }
  return { origin, parentWindow };
}
