/**
 * Pure network ring buffer + CDP event normalization (Node +
 * extension, dependency-free).
 *
 * No Chrome/CDP/Node APIs here: callers supply already-extracted raw event
 * dicts. The extension (DebuggerSessionManager) owns debugger attachment
 * and event routing; this module owns bounded correlation, safe projection,
 * strict header/URL redaction, and response budgeting.
 *
 * Hard rules:
 * - Raw CDP requestIds NEVER leave this module: public ids are
 *   project-owned opaque observation ids (n-<counter>, stable per entry).
 * - No bodies: no postData, no form bodies, no response bodies or previews.
 *   A boolean hasPostData flag is the only body signal.
 * - Sensitive headers (Authorization, Cookie, Set-Cookie,
 *   Proxy-Authorization, X-Api-Key, X-Auth-Token) are ALWAYS fully replaced
 *   with [REDACTED] (case-insensitive, no prefix preservation).
 * - URLs are sanitized (sensitive query values + embedded credentials).
 * - Correlation state is bounded (hard max 2000 pending); redirects are
 *   deterministic (single entry updated, never forked).
 */

import {
  NETWORK_CORRELATION_HARD_MAX,
  NETWORK_HEADER_VALUE_LIMIT_CHARS,
  NETWORK_MAX_HEADERS_PER_DIRECTION,
  NETWORK_STRING_LIMIT_CHARS,
  OBSERVABILITY_DEFAULT_RETRIEVAL_LIMIT,
  OBSERVABILITY_MAX_RETRIEVAL_LIMIT,
  OBSERVABILITY_MAX_SERIALIZED_BYTES,
  observabilityUtf8Length,
} from "./observabilityPolicy.js";
import { redactHeaders, sanitizeUrl } from "../security/Redaction.js";

export interface NetworkEntry {
  readonly id: string;
  readonly startedAt: string;
  readonly method: string;
  readonly url: string;
  readonly resourceType?: string;
  readonly requestHeaders: Record<string, string>;
  readonly hasPostData: boolean;
  readonly status?: number;
  readonly statusText?: string;
  readonly responseHeaders?: Record<string, string>;
  readonly mimeType?: string;
  readonly protocol?: string;
  readonly fromDiskCache?: boolean;
  readonly failed?: boolean;
  readonly errorText?: string;
}

export interface NetworkGetResult {
  readonly tabId: string;
  readonly monitoring: boolean;
  readonly capacity: number;
  readonly availableEntries: number;
  readonly returnedEntries: number;
  readonly droppedCount: number;
  readonly truncated: boolean;
  readonly entries: readonly NetworkEntry[];
}

export interface NetworkClearResult {
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

function boundedTimestamp(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw !== "" ? truncate(raw, 64) : fallback;
}

function boundedMethod(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") {
    return "GET";
  }
  return truncate(raw.toUpperCase().slice(0, 16), 16);
}

/** Project headers from a CDP headers dict: bounded, redacted, capped. */
export function projectHeaders(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) {
    return {};
  }
  const collected: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of Object.entries(raw)) {
    if (count >= NETWORK_MAX_HEADERS_PER_DIRECTION) {
      break;
    }
    if (typeof value !== "string" || name === "") {
      continue;
    }
    count += 1;
    collected[truncate(name, 128)] = value;
  }
  return redactHeaders(collected, NETWORK_HEADER_VALUE_LIMIT_CHARS);
}

interface PendingRequest {
  entry: NetworkEntry;
  redirectCount: number;
}

function newObservationId(counter: number): string {
  return `n-${counter.toString(36)}`;
}

/** Bounded network monitor: ring buffer + bounded correlation map. */
export class NetworkMonitor {
  private readonly finished: NetworkEntry[] = [];
  private readonly pending = new Map<string, PendingRequest>();
  private dropped = 0;
  private observationCounter = 0;

  constructor(private capacity: number) {}

  getCapacity(): number {
    return this.capacity;
  }

  getDroppedCount(): number {
    return this.dropped;
  }

  getSize(): number {
    return this.finished.length;
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  /** Ingest Network.requestWillBeSent params (already validated by caller). */
  requestWillBeSent(
    rawRequestId: string,
    params: Record<string, unknown>,
    startedAt: string,
  ): void {
    const request = isRecord(params["request"]) ? (params["request"] as Record<string, unknown>) : {};
    const rawUrl = typeof request["url"] === "string" ? (request["url"] as string) : "";
    const entry: NetworkEntry = this.blankEntry(startedAt);
    (entry as { method?: string }).method = boundedMethod(request["method"]);
    (entry as { url?: string }).url = sanitizeUrl(rawUrl, NETWORK_STRING_LIMIT_CHARS);
    const resourceType = params["type"];
    if (typeof resourceType === "string" && resourceType !== "") {
      (entry as { resourceType?: string }).resourceType = truncate(resourceType, 64);
    }
    (entry as { requestHeaders?: Record<string, string> }).requestHeaders = projectHeaders(request["headers"]);
    const hasPostData =
      request["hasPostData"] === true ||
      (typeof request["postData"] === "string" && (request["postData"] as string) !== "");
    (entry as { hasPostData?: boolean }).hasPostData = hasPostData === true;
    // Redirect: same raw requestId continues (CDP emits requestWillBeSent
    // again with redirectResponse). Update the single entry deterministically.
    const existing = this.pending.get(rawRequestId);
    if (existing !== undefined) {
      const merged: NetworkEntry = { ...existing.entry, ...stripUnset(entry), id: existing.entry.id };
      this.pending.set(rawRequestId, { entry: merged, redirectCount: existing.redirectCount + 1 });
      return;
    }
    // New request: enforce the bounded correlation map (drop oldest pending).
    if (this.pending.size >= NETWORK_CORRELATION_HARD_MAX) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) {
        this.pending.delete(oldest.value);
        this.dropped += 1;
      }
    }
    this.pending.set(rawRequestId, { entry, redirectCount: 0 });
  }

  /** Ingest Network.responseReceived params. */
  responseReceived(rawRequestId: string, params: Record<string, unknown>): void {
    const pending = this.pending.get(rawRequestId);
    if (pending === undefined) {
      return;
    }
    const response = isRecord(params["response"]) ? (params["response"] as Record<string, unknown>) : {};
    const status = typeof response["status"] === "number" && Number.isInteger(response["status"]) ? (response["status"] as number) : undefined;
    const statusText = typeof response["statusText"] === "string" ? truncate(response["statusText"] as string, 128) : undefined;
    const mimeType = typeof response["mimeType"] === "string" ? truncate(response["mimeType"] as string, 128) : undefined;
    const protocol = typeof response["protocol"] === "string" ? truncate(response["protocol"] as string, 64) : undefined;
    const fromDiskCache = typeof response["fromDiskCache"] === "boolean" ? (response["fromDiskCache"] as boolean) : undefined;
    const merged: NetworkEntry = { ...pending.entry };
    if (status !== undefined) {
      (merged as { status?: number }).status = status;
    }
    if (statusText !== undefined) {
      (merged as { statusText?: string }).statusText = statusText;
    }
    (merged as { responseHeaders?: Record<string, string> }).responseHeaders = projectHeaders(response["headers"]);
    if (mimeType !== undefined) {
      (merged as { mimeType?: string }).mimeType = mimeType;
    }
    if (protocol !== undefined) {
      (merged as { protocol?: string }).protocol = protocol;
    }
    if (fromDiskCache !== undefined) {
      (merged as { fromDiskCache?: boolean }).fromDiskCache = fromDiskCache;
    }
    this.pending.set(rawRequestId, { entry: merged, redirectCount: pending.redirectCount });
  }

  /** Ingest Network.loadingFinished: complete and publish the entry. */
  loadingFinished(rawRequestId: string): void {
    const pending = this.pending.get(rawRequestId);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(rawRequestId);
    this.pushFinished(pending.entry);
  }

  /** Ingest Network.loadingFailed: mark failed, publish, clean correlation. */
  loadingFailed(rawRequestId: string, params: Record<string, unknown>): void {
    const pending = this.pending.get(rawRequestId);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(rawRequestId);
    const errorText = typeof params["errorText"] === "string" ? truncate(params["errorText"] as string, 256) : undefined;
    const merged: NetworkEntry = { ...pending.entry, failed: true };
    if (errorText !== undefined) {
      (merged as { errorText?: string }).errorText = errorText;
    }
    this.pushFinished(merged);
  }

  /** Newest `limit` finished entries in chronological order. */
  newest(limit: number): NetworkEntry[] {
    const safe = normalizeNetworkLimit(limit);
    if (this.finished.length <= safe) {
      return [...this.finished];
    }
    return this.finished.slice(this.finished.length - safe);
  }

  clear(): number {
    const removed = this.finished.length;
    this.finished.length = 0;
    this.pending.clear();
    this.dropped = 0;
    return removed;
  }

  removePendingForTabReset(): void {
    this.pending.clear();
  }

  resize(newCapacity: number): void {
    if (!Number.isInteger(newCapacity) || newCapacity <= 0) {
      return;
    }
    this.capacity = newCapacity;
    while (this.finished.length > this.capacity) {
      this.finished.shift();
      this.dropped += 1;
    }
  }

  private blankEntry(startedAt: string): NetworkEntry {
    this.observationCounter += 1;
    const entry: NetworkEntry = {
      id: newObservationId(this.observationCounter),
      startedAt: boundedTimestamp(startedAt, ""),
      method: "GET",
      url: "",
      requestHeaders: {},
      hasPostData: false,
    };
    return entry;
  }

  private pushFinished(entry: NetworkEntry): void {
    if (this.finished.length >= this.capacity) {
      this.finished.shift();
      this.dropped += 1;
    }
    this.finished.push(entry);
  }
}

/** Copy only set (non-default) fields from a fresh blank for redirect merge. */
function stripUnset(entry: NetworkEntry): Partial<NetworkEntry> {
  const out: Partial<NetworkEntry> = {
    method: entry.method,
    url: entry.url,
    requestHeaders: entry.requestHeaders,
    hasPostData: entry.hasPostData,
  };
  if (entry.resourceType !== undefined) {
    (out as { resourceType?: string }).resourceType = entry.resourceType;
  }
  if (entry.status !== undefined) {
    (out as { status?: number }).status = entry.status;
  }
  if (entry.statusText !== undefined) {
    (out as { statusText?: string }).statusText = entry.statusText;
  }
  if (entry.responseHeaders !== undefined) {
    (out as { responseHeaders?: Record<string, string> }).responseHeaders = entry.responseHeaders;
  }
  if (entry.mimeType !== undefined) {
    (out as { mimeType?: string }).mimeType = entry.mimeType;
  }
  if (entry.protocol !== undefined) {
    (out as { protocol?: string }).protocol = entry.protocol;
  }
  if (entry.fromDiskCache !== undefined) {
    (out as { fromDiskCache?: boolean }).fromDiskCache = entry.fromDiskCache;
  }
  return out;
}

function normalizeNetworkLimit(raw: unknown): number {
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
export function buildNetworkResponse(
  tabId: string,
  capacity: number,
  allEntries: readonly NetworkEntry[],
  droppedCount: number,
  limit: number,
): NetworkGetResult {
  const safeLimit = normalizeNetworkLimit(limit);
  const availableEntries = allEntries.length;
  const requested = availableEntries <= safeLimit ? [...allEntries] : allEntries.slice(availableEntries - safeLimit);
  const measure = (candidate: readonly NetworkEntry[]): number =>
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
  let fitted: readonly NetworkEntry[] = requested;
  let truncated = false;
  if (measure(fitted) > OBSERVABILITY_MAX_SERIALIZED_BYTES) {
    truncated = true;
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
