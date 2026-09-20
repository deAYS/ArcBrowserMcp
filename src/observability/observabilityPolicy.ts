/**
 * Shared observability policy (Node + extension, dependency-free).
 *
 * Owns the browser-neutral observability boundaries so both sides enforce
 * the same contract without duplicating magic values:
 * - console/network ring-buffer defaults and hard-maximum capacities
 * - retrieval defaults (limit 100, hard max 500)
 * - serialized public response budget (512 KiB per call)
 * - per-field text bounds used by the extension monitors
 *
 * No Chrome/CDP/Node APIs here; the extension bundle imports this module
 * directly (same precedent as pageToolsPolicy/interactionPolicy).
 */

/** Default console ring capacity (200 entries). */
export const CONSOLE_BUFFER_DEFAULT_ENTRIES = 200;
/** Hard-maximum console ring capacity (2000 entries). */
export const CONSOLE_BUFFER_HARD_MAX_ENTRIES = 2000;

/** Default network ring capacity (500 entries). */
export const NETWORK_BUFFER_DEFAULT_ENTRIES = 500;
/** Hard-maximum network ring capacity (5000 entries). */
export const NETWORK_BUFFER_HARD_MAX_ENTRIES = 5000;

/** Default retrieval limit for get (100 newest entries). */
export const OBSERVABILITY_DEFAULT_RETRIEVAL_LIMIT = 100;
/** Hard retrieval limit for get (500 entries). */
export const OBSERVABILITY_MAX_RETRIEVAL_LIMIT = 500;

/**
 * Hard cap over the complete serialized PUBLIC observability response
 * (UTF-8 bytes of JSON.stringify of the exact result object). Bounded so a
 * noisy page can never produce a multi-megabyte MCP payload.
 */
export const OBSERVABILITY_MAX_SERIALIZED_BYTES = 512 * 1024;

/** Per console argument rendered-text bound (chars). */
export const CONSOLE_ARG_TEXT_LIMIT_CHARS = 1024;
/** Per console event rendered-text bound (chars). */
export const CONSOLE_EVENT_TEXT_LIMIT_CHARS = 4000;
/** Console source URL bound (chars). */
export const CONSOLE_SOURCE_URL_LIMIT_CHARS = 2048;

/** Network URL/metadata string bound (chars). */
export const NETWORK_STRING_LIMIT_CHARS = 2048;
/** Network single header value bound (chars). */
export const NETWORK_HEADER_VALUE_LIMIT_CHARS = 1024;
/** Network max headers retained per direction (entries). */
export const NETWORK_MAX_HEADERS_PER_DIRECTION = 64;
/** Internal request-correlation map hard bound (entries). */
export const NETWORK_CORRELATION_HARD_MAX = 2000;

/** UTF-8 byte length without Node APIs (extension-safe). */
export function observabilityUtf8Length(value: string): number {
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

/**
 * Resolve a configured buffer capacity deterministically:
 * - undefined/"" -> default
 * - positive integer within hard max -> as configured
 * - anything else (zero, negative, non-integer, > hard max) -> invalid
 *   (callers throw the typed config error; the extension clamps instead).
 */
export function resolveBufferCapacity(
  raw: string | number | undefined,
  defaultEntries: number,
  hardMaxEntries: number,
): { ok: true; capacity: number } | { ok: false; reason: string } {
  if (raw === undefined || raw === "") {
    return { ok: true, capacity: defaultEntries };
  }
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, reason: "capacity must be a positive integer" };
  }
  if (parsed > hardMaxEntries) {
    return { ok: false, reason: `capacity exceeds the hard maximum of ${String(hardMaxEntries)}` };
  }
  return { ok: true, capacity: parsed };
}

/** Extension-side clamp: never allow more than the hard maximum. */
export function clampBufferCapacity(requested: number | undefined, defaultEntries: number, hardMaxEntries: number): number {
  if (requested === undefined || !Number.isInteger(requested) || requested <= 0) {
    return defaultEntries;
  }
  return Math.min(requested, hardMaxEntries);
}

/**
 * Normalize a get limit: default 100, integers only, clamped to the hard
 * retrieval max (callers may throw instead; shared clamp for the wire).
 */
export function normalizeRetrievalLimit(raw: unknown): number {
  if (raw === undefined) {
    return OBSERVABILITY_DEFAULT_RETRIEVAL_LIMIT;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return OBSERVABILITY_DEFAULT_RETRIEVAL_LIMIT;
  }
  return Math.min(raw, OBSERVABILITY_MAX_RETRIEVAL_LIMIT);
}
