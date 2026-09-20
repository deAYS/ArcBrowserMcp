/**
 * Shared capability policy (Node + extension, dependency-free).
 *
 * Owns the browser-neutral boundaries so both sides enforce the same
 * contract without duplicating magic values:
 * - evaluate: expression UTF-8 cap (64 KiB), timeout default/max, public
 *   result serialized cap (256 KiB), special JS value tags.
 * - screenshot: decoded PNG cap (8 MiB, mirrors the transport model),
 *   PNG signature bytes.
 * - wait: condition value UTF-8 cap (4096), timeout default/max, poll
 *   cadence, condition taxonomy.
 *
 * No Chrome/CDP/Node APIs here; the extension bundle imports this module
 * directly (same precedent as navigationPolicy/interactionPolicy).
 */

import { SCREENSHOT_MAX_DECODED_BYTES } from "../bridge/frameLimits.js";

/** Max evaluate expression size: 64 KiB UTF-8 (rejected before dispatch). */
export const EVALUATE_EXPRESSION_LIMIT_BYTES = 64 * 1024;

/** Default evaluate deadline: 5000 ms. */
export const EVALUATE_DEFAULT_TIMEOUT_MS = 5_000;

/** Hard maximum evaluate deadline: 10000 ms. */
export const EVALUATE_MAX_TIMEOUT_MS = 10_000;

/** Hard cap over the complete serialized PUBLIC evaluation result. */
export const EVALUATE_RESULT_MAX_SERIALIZED_BYTES = 256 * 1024;

/** Max wait condition value size: 4096 UTF-8 bytes. */
export const WAIT_CONDITION_LIMIT_BYTES = 4_096;

/** Default wait deadline: 5000 ms. */
export const WAIT_DEFAULT_TIMEOUT_MS = 5_000;

/** Hard maximum wait deadline: 30000 ms. */
export const WAIT_MAX_TIMEOUT_MS = 30_000;

/** Minimum wait deadline (must be a positive, sane bound). */
export const WAIT_MIN_TIMEOUT_MS = 50;

/** Internal wait poll cadence: bounded polling, never one giant sleep. */
export const WAIT_POLL_INTERVAL_MS = 150;

/** Decoded PNG hard cap (mirrors the transport capacity model). */
export const SCREENSHOT_DECODED_LIMIT_BYTES = SCREENSHOT_MAX_DECODED_BYTES;

/** PNG file signature: 89 50 4E 47 0D 0A 1A 0A. */
export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** UTF-8 byte length without Node APIs (extension-safe). */
export function pageToolsUtf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Project-owned special JS value tags for the evaluate envelope. */
export const EVALUATE_SPECIAL_TAGS = new Set([
  "undefined",
  "nan",
  "infinity",
  "neg-infinity",
  "neg-zero",
  "bigint",
]);

export type WaitConditionType = "load" | "url" | "title" | "text";

export function isWaitConditionType(value: string): value is WaitConditionType {
  return value === "load" || value === "url" || value === "title" || value === "text";
}
