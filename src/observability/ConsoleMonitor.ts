/**
 * Pure console ring buffer + CDP event normalization for P09 (Node +
 * extension, dependency-free).
 *
 * No Chrome/CDP/Node APIs here: callers supply already-extracted raw event
 * dicts plus an ISO timestamp. The extension (DebuggerSessionManager) owns
 * debugger attachment and event routing; this module owns bounded storage,
 * safe projection, heuristic redaction, and response budgeting.
 *
 * Security: primitives are rendered safely, complex objects/functions use
 * bounded type placeholders (never traversing properties, never calling
 * Runtime.getProperties), raw RemoteObject shapes/ids never appear in
 * output. Console text gets bounded heuristic redaction; structured
 * header/URL guarantees live in Redaction.ts (network side).
 */

import {
  CONSOLE_ARG_TEXT_LIMIT_CHARS,
  CONSOLE_EVENT_TEXT_LIMIT_CHARS,
  CONSOLE_SOURCE_URL_LIMIT_CHARS,
  OBSERVABILITY_MAX_RETRIEVAL_LIMIT,
  OBSERVABILITY_DEFAULT_RETRIEVAL_LIMIT,
  OBSERVABILITY_MAX_SERIALIZED_BYTES,
  observabilityUtf8Length,
} from "./observabilityPolicy.js";
import { redactConsoleText, sanitizeUrl } from "../security/Redaction.js";

export type ConsoleLevel = "log" | "info" | "warning" | "error" | "debug";

export interface ConsoleSource {
  readonly url?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface ConsoleEntry {
  readonly timestamp: string;
  readonly level: ConsoleLevel;
  readonly text: string;
  readonly source?: ConsoleSource;
}

export interface ConsoleGetResult {
  readonly tabId: string;
  readonly monitoring: boolean;
  readonly capacity: number;
  readonly availableEntries: number;
  readonly returnedEntries: number;
  readonly droppedCount: number;
  readonly truncated: boolean;
  readonly entries: readonly ConsoleEntry[];
}

export interface ConsoleClearResult {
  readonly cleared: true;
  readonly removedEntries: number;
  readonly monitoring: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function toLevel(raw: unknown): ConsoleLevel {
  if (raw === "info") {
    return "info";
  }
  if (raw === "warning") {
    return "warning";
  }
  if (raw === "error") {
    return "error";
  }
  if (raw === "debug") {
    return "debug";
  }
  return "log";
}

function boundedInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000) {
    return value;
  }
  return undefined;
}

/**
 * Render one console argument safely:
 * - null/undefined -> literal words
 * - string/number/boolean without objectId -> bounded primitive text
 * - unserializableValue (NaN/Infinity/-0) -> bounded literal
 * - everything else (objects, functions, symbols, objectId present,
 *   previews, descriptions) -> bounded type placeholder, never raw content.
 */
export function renderConsoleArg(arg: unknown): string {
  if (arg === null) {
    return "null";
  }
  if (arg === undefined) {
    return "undefined";
  }
  if (!isRecord(arg)) {
    return truncate(String(arg), CONSOLE_ARG_TEXT_LIMIT_CHARS);
  }
  // Raw RemoteObject shape: never expose objectId/executionContextId/preview.
  if (typeof arg["objectId"] === "string") {
    const type = typeof arg["type"] === "string" ? (arg["type"] as string) : "object";
    if (type === "function") {
      return "[function]";
    }
    return "[object]";
  }
  if (typeof arg["unserializableValue"] === "string") {
    return truncate(arg["unserializableValue"] as string, CONSOLE_ARG_TEXT_LIMIT_CHARS);
  }
  const type = typeof arg["type"] === "string" ? (arg["type"] as string) : "";
  if (type === "string" && typeof arg["value"] === "string") {
    return truncate(arg["value"] as string, CONSOLE_ARG_TEXT_LIMIT_CHARS);
  }
  if (type === "number" && typeof arg["value"] === "number") {
    const num = arg["value"] as number;
    if (!Number.isFinite(num)) {
      return "[non-finite number]";
    }
    return truncate(Object.is(num, -0) ? "0" : String(num), CONSOLE_ARG_TEXT_LIMIT_CHARS);
  }
  if (type === "boolean" && typeof arg["value"] === "boolean") {
    return (arg["value"] as boolean) ? "true" : "false";
  }
  if (type === "undefined") {
    return "undefined";
  }
  if (type === "function") {
    return "[function]";
  }
  if (type === "object" || type === "symbol" || type === "bigint") {
    return type === "symbol" ? "[symbol]" : type === "bigint" ? "[bigint]" : "[object]";
  }
  // Unknown shape: placeholder, never raw traversal.
  return "[value]";
}

function extractSource(params: Record<string, unknown>): ConsoleSource | undefined {
  // Prefer the top stack frame when present.
  const stackTrace = params["stackTrace"];
  if (isRecord(stackTrace) && Array.isArray(stackTrace["callFrames"])) {
    const first = (stackTrace["callFrames"] as unknown[])[0];
    if (isRecord(first)) {
      const url = typeof first["url"] === "string" ? sanitizeUrl(first["url"], CONSOLE_SOURCE_URL_LIMIT_CHARS) : "";
      const line = boundedInt(first["lineNumber"]);
      const column = boundedInt(first["columnNumber"]);
      const source: ConsoleSource = {};
      if (url !== "") {
        (source as { url?: string }).url = url;
      }
      if (line !== undefined) {
        // CDP line numbers are 0-based; expose 1-based for agents.
        (source as { line?: number }).line = line + 1;
      }
      if (column !== undefined) {
        (source as { column?: number }).column = column + 1;
      }
      if (source.url !== undefined || source.line !== undefined || source.column !== undefined) {
        return source;
      }
    }
  }
  const urlParam = params["url"];
  if (typeof urlParam === "string" && urlParam !== "") {
    const sanitized = sanitizeUrl(urlParam, CONSOLE_SOURCE_URL_LIMIT_CHARS);
    if (sanitized !== "") {
      return { url: sanitized };
    }
  }
  return undefined;
}

/**
 * Normalize a raw Runtime.consoleAPICalled params dict into a bounded
 * sanitized ConsoleEntry. Never throws outward with raw content; failures
 * produce a minimal safe entry.
 */
export function normalizeConsoleAPICalled(
  params: Record<string, unknown>,
  timestamp: string,
): ConsoleEntry {
  try {
    const level = toLevel(params["type"]);
    const rawArgs = Array.isArray(params["args"]) ? (params["args"] as unknown[]) : [];
    const parts: string[] = [];
    for (const arg of rawArgs.slice(0, 32)) {
      parts.push(renderConsoleArg(arg));
      if (parts.join(" ").length > CONSOLE_EVENT_TEXT_LIMIT_CHARS) {
        break;
      }
    }
    const joined = truncate(parts.join(" "), CONSOLE_EVENT_TEXT_LIMIT_CHARS);
    const text = redactConsoleText(joined, CONSOLE_EVENT_TEXT_LIMIT_CHARS);
    const source = extractSource(params);
    const entry: ConsoleEntry = { timestamp, level, text };
    if (source !== undefined) {
      (entry as { source?: ConsoleSource }).source = source;
    }
    return entry;
  } catch {
    return { timestamp, level: "log", text: "" };
  }
}

/**
 * Normalize a raw Runtime.exceptionThrown params dict into a bounded console
 * error entry. Only the safe `text` summary is used; exception description,
 * value, and stack contents are never surfaced (they may carry page secrets).
 */
export function normalizeExceptionThrown(
  params: Record<string, unknown>,
  timestamp: string,
): ConsoleEntry {
  try {
    const details = isRecord(params["exceptionDetails"]) ? (params["exceptionDetails"] as Record<string, unknown>) : {};
    const rawText = typeof details["text"] === "string" ? (details["text"] as string) : "Uncaught exception";
    const text = redactConsoleText(truncate(rawText, CONSOLE_EVENT_TEXT_LIMIT_CHARS), CONSOLE_EVENT_TEXT_LIMIT_CHARS);
    const source = extractSource(details);
    const entry: ConsoleEntry = { timestamp, level: "error", text };
    if (source !== undefined) {
      (entry as { source?: ConsoleSource }).source = source;
    }
    return entry;
  } catch {
    return { timestamp, level: "error", text: "Uncaught exception" };
  }
}

/** Bounded ring buffer for sanitized console entries (oldest evicted). */
export class ConsoleMonitor {
  private readonly entries: ConsoleEntry[] = [];
  private dropped = 0;

  constructor(private capacity: number) {}

  getCapacity(): number {
    return this.capacity;
  }

  getDroppedCount(): number {
    return this.dropped;
  }

  getSize(): number {
    return this.entries.length;
  }

  ingest(entry: ConsoleEntry): void {
    if (this.entries.length >= this.capacity) {
      this.entries.shift();
      this.dropped += 1;
    }
    this.entries.push(entry);
  }

  /** Newest `limit` entries in chronological order (oldest->newest). */
  newest(limit: number): ConsoleEntry[] {
    const safe = normalizeLimit(limit);
    if (this.entries.length <= safe) {
      return [...this.entries];
    }
    return this.entries.slice(this.entries.length - safe);
  }

  clear(): number {
    const removed = this.entries.length;
    this.entries.length = 0;
    this.dropped = 0;
    return removed;
  }

  resize(newCapacity: number): void {
    if (!Number.isInteger(newCapacity) || newCapacity <= 0) {
      return;
    }
    this.capacity = newCapacity;
    while (this.entries.length > this.capacity) {
      this.entries.shift();
      this.dropped += 1;
    }
  }
}

function normalizeLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return OBSERVABILITY_DEFAULT_RETRIEVAL_LIMIT;
  }
  return Math.min(raw, OBSERVABILITY_MAX_RETRIEVAL_LIMIT);
}

/**
 * Build the bounded public get response: newest `limit` entries, trimmed
 * from the oldest side until the complete serialized envelope fits the
 * 512 KiB budget. Preserves chronological order, prefers newest, sets
 * truncated when budget trimming occurred.
 */
export function buildConsoleResponse(
  tabId: string,
  capacity: number,
  allEntries: readonly ConsoleEntry[],
  droppedCount: number,
  limit: number,
): ConsoleGetResult {
  const safeLimit = normalizeLimit(limit);
  const availableEntries = allEntries.length;
  const requested = availableEntries <= safeLimit ? [...allEntries] : allEntries.slice(availableEntries - safeLimit);
  const measure = (candidate: readonly ConsoleEntry[]): number =>
    observabilityUtf8Length(
      JSON.stringify({
        tabId,
        monitoring: true,
        capacity,
        availableEntries,
        returnedEntries: candidate.length,
        droppedCount,
        truncated: false,
        entries: candidate,
      }),
    );
  let fitted: readonly ConsoleEntry[] = requested;
  let truncated = false;
  if (measure(fitted) > OBSERVABILITY_MAX_SERIALIZED_BYTES) {
    truncated = true;
    // Binary search the smallest suffix that fits (newest entries win).
    let low = 0;
    let high = fitted.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = fitted.slice(mid);
      if (measure(candidate) <= OBSERVABILITY_MAX_SERIALIZED_BYTES) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    fitted = fitted.slice(low);
    // Absolute guard: pathological single entry still over budget -> empty.
    if (measure(fitted) > OBSERVABILITY_MAX_SERIALIZED_BYTES) {
      fitted = [];
    }
  }
  return {
    tabId,
    monitoring: true,
    capacity,
    availableEntries,
    returnedEntries: fitted.length,
    droppedCount,
    truncated,
    entries: [...fitted],
  };
}
