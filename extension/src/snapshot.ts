/**
 * Extension-side snapshot capture (DOM-free, no global chrome use).
 *
 * Owns the debugger lifecycle for page inspection through the small
 * DebuggerSessionManager below:
 * - project TabId -> numeric Chrome tab resolution (via injected resolver)
 * - lazy attachment with an idle lifetime: attach on first use, detach
 *   after 60 s without CDP traffic (plus an opportunistic sweep whenever
 *   work starts on another tab and a 1-minute alarm for fully idle
 *   browsers); detach never steals a foreign session. Refs and cursor
 *   state survive idle detaches, so the next operation reattaches
 *   transparently — only the automation surface (infobar + CDP
 *   observability) and live event domains are dropped.
 * - external onDetach handling clears ownership and invalidates refs
 * - tab close / navigation / external same-URL reload invalidates refs
 *   (fail closed, never retarget)
 *
 * Snapshot source is Accessibility semantics (Accessibility.enable +
 * Accessibility.getFullAXTree), normalized by the shared
 * snapshotSemantics module. Bounded DOM.describeNode supplementation is
 * used ONLY to positively classify value-bearing editable controls
 * (fail-closed value redaction), never for markup scraping.
 * Two fixed page-tool paths exist on the same manager (never generic CDP):
 * runtime.evaluate (browser_evaluate) and page.screenshot
 * (browser_screenshot, viewport PNG).
 * Bounded console/network observability lives on the same manager
 * (never a second ownership system): Runtime.enable for console events,
 * Network.enable for network events, routed through ONE chrome.debugger
 * onEvent path. Raw events never cross the bridge; only sanitized,
 * redacted, bounded project-owned entries leave the extension. Buffers are
 * in-memory per tab (worker restart resets them; never persisted to
 * chrome.storage).
 *
 * about:blank policy (deterministic): treated as NOT controllable, matching
 * the isControllableUrl rule (only http:/https: are controllable).
 *
 * Reference model: latest-snapshot-only. Each successful capture replaces
 * the tab's ref table; earlier refs fail closed. Refs are opaque
 * (e-<32hex session>-<snap>-<ctr>) scoped to (session, tab, snapshot).
 * The session id is 128 cryptographic bits (crypto.getRandomValues of 16
 * bytes, never Math.random/Date.now/PID/counter); a worker/browser restart
 * mints a new session (persisted in session storage across suspension), so
 * old refs cannot collide or retarget.
 *
 * Payload bound: the complete serialized snapshot (nodes + refs + text +
 * metadata) is hard-capped at SNAPSHOT_MAX_SERIALIZED_BYTES (256 KiB);
 * excess trailing nodes are dropped with truncated=true.
 */

import {
  ELEMENT_REF_PATTERN,
  SNAPSHOT_MAX_SERIALIZED_BYTES,
  normalizeAxTree,
  type NormalizeOptions,
  type RawAxNode,
  type SnapshotNode,
} from "../../src/browser/snapshotSemantics.js";
import {
  HUMANIZE_SEQUENCE_DELAY_MAX_MS,
  HUMANIZE_SEQUENCE_DELAY_MIN_MS,
  HUMANIZE_WPM_DEFAULT,
  HUMANIZE_WPM_MAX,
  HUMANIZE_WPM_MIN,
  HUMAN_KEYS_MODE_MAX_CHARS,
  INTERACTION_TEXT_LIMIT_BYTES,
  PRESS_SEQUENCE_MAX_KEYS,
  hoverDwellMs,
  jitterClickPoint,
  normalizeHumanTypeMode,
  normalizeSequenceDelayMs,
  normalizeWpm,
  parsePressKey,
  planInsertChunks,
  planKeystrokes,
  planMouseMove,
  pressHoldMs,
  utf8ByteLength,
  type HumanRng,
  type HumanTypeMode,
  type MousePoint,
} from "../../src/browser/interactionPolicy.js";
import {
  EVALUATE_DEFAULT_TIMEOUT_MS,
  EVALUATE_MAX_TIMEOUT_MS,
  EVALUATE_EXPRESSION_LIMIT_BYTES,
  EVALUATE_RESULT_MAX_SERIALIZED_BYTES,
  PNG_SIGNATURE,
  SCREENSHOT_DECODED_LIMIT_BYTES,
  WAIT_CONDITION_LIMIT_BYTES,
  pageToolsUtf8Length,
} from "../../src/browser/pageToolsPolicy.js";
import { LARGE_RESPONSE_FRAME_MAX_BYTES } from "../../src/bridge/frameLimits.js";
import {
  CONSOLE_BUFFER_DEFAULT_ENTRIES,
  CONSOLE_BUFFER_HARD_MAX_ENTRIES,
  NETWORK_BUFFER_DEFAULT_ENTRIES,
  NETWORK_BUFFER_HARD_MAX_ENTRIES,
  NETWORK_CORRELATION_HARD_MAX,
  OBSERVABILITY_MAX_RETRIEVAL_LIMIT,
  OBSERVABILITY_MAX_SERIALIZED_BYTES,
  clampBufferCapacity,
  observabilityUtf8Length,
} from "../../src/observability/observabilityPolicy.js";
import {
  normalizeConsoleAPICalled,
  normalizeExceptionThrown,
  type ConsoleEntry,
} from "../../src/observability/ConsoleMonitor.js";
import type { NetworkEntry } from "../../src/observability/NetworkMonitor.js";
import { projectHeaders } from "../../src/observability/NetworkMonitor.js";
import { redactConsoleText, sanitizeUrl } from "../../src/security/Redaction.js";

export const DEBUG_PROTOCOL_VERSION = "1.3";

/**
 * Allowlisted CDP methods for snapshots + interactions +
 * page tools + observability. Nothing else may be sent.
 *
 * Two more fixed methods exist, each reachable ONLY
 * through its explicit bridge method:
 * - Runtime.evaluate: ONLY the runtime.evaluate path (browser_evaluate).
 *   Never snapshot, never interactions, never wait, never screenshot,
 *   never observability.
 * - Page.captureScreenshot: ONLY the page.screenshot path
 *   (browser_screenshot, viewport PNG). Page.enable is NOT allowlisted:
 *   Chromium does not require it for captureScreenshot.
 *
 * Two narrow observability capabilities exist, each reachable ONLY
 * through its explicit bridge method:
 * - observability-console: Runtime.enable ONLY (browser_console get/clear).
 *   Events (Runtime.consoleAPICalled, Runtime.exceptionThrown) arrive via
 *   chrome.debugger.onEvent and are normalized extension-side; Runtime events
 *   are never a command surface and Runtime.getProperties is never used.
 * - observability-network: Network.enable ONLY (browser_network get/clear).
 *   Events (requestWillBeSent/responseReceived/loadingFinished/loadingFailed)
 *   arrive via onEvent and are normalized extension-side; getResponseBody,
 *   getRequestPostData, ExtraInfo events, and all Network.set* are never used.
 */
export const CDP_CAPABILITY_METHODS = Object.freeze({
  snapshot: Object.freeze(["Accessibility.enable", "Accessibility.getFullAXTree", "DOM.enable", "DOM.describeNode"] as const),
  interaction: Object.freeze([
    "Accessibility.enable", "Accessibility.getFullAXTree", "Accessibility.getPartialAXTree",
    "DOM.enable", "DOM.describeNode", "DOM.scrollIntoViewIfNeeded", "DOM.getContentQuads", "DOM.focus",
    "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText",
  ] as const),
  evaluate: Object.freeze(["Runtime.evaluate"] as const),
  screenshot: Object.freeze(["Page.captureScreenshot"] as const),
  // Wait performs semantic-text polling plus the same fail-closed
  // editable-value classification snapshots use (DOM.describeNode probes),
  // so DOM.enable/describeNode are genuinely required here too.
  wait: Object.freeze(["Accessibility.enable", "Accessibility.getFullAXTree", "DOM.enable", "DOM.describeNode"] as const),
  // Observability: console needs Runtime.enable only; network needs
  // Network.enable only. Event traffic is onEvent-routed, never a command.
  "observability-console": Object.freeze(["Runtime.enable"] as const),
  "observability-network": Object.freeze(["Network.enable"] as const),
});

export function createScopedCdpSender<K extends keyof typeof CDP_CAPABILITY_METHODS>(
  capability: K,
  transport: DebuggerChrome["sendCommand"],
): (chromeId: number, method: (typeof CDP_CAPABILITY_METHODS)[K][number], params?: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const allowed: readonly string[] = CDP_CAPABILITY_METHODS[capability];
  return async (chromeId, method, params) => {
    if (!allowed.includes(method)) {
      throw new SnapshotError("SNAPSHOT_FAILED", "debugger command is outside the operation capability");
    }
    return transport(chromeId, method, params);
  };
}

/** Operation capability names for the scoped CDP boundary. */
export type CdpCapability = keyof typeof CDP_CAPABILITY_METHODS;

/** Methods issuable through one operation's scoped sender. */
export type CdpCapabilityMethod<K extends CdpCapability> = (typeof CDP_CAPABILITY_METHODS)[K][number];

/**
 * Bounded retirement deadline for the owned-debugger detach that follows
 * an evaluation await-timeout (default 3000 ms, overridable for tests).
 *
 * Fits inside the engine's bridge margin (bridge timeout is
 * timeoutMs + 5000 ms), so the public evaluation operation stays bounded
 * even when the detach itself stalls. A detach failure/stall marks the
 * tab session uncertain (fail closed) instead of permitting a raced
 * reattachment.
 */
export const RETIRE_DETACH_TIMEOUT_MS = 3_000;

/**
 * Idle debugger lifetime: an owned attachment with no CDP traffic for this
 * long is detached (default 60 s, overridable for tests). Rationale: a
 * persistently attached debugger is a strong automation signal (infobar +
 * CDP side-effects observable by page JavaScript for the whole session),
 * which is what gets regular browsing flagged by bot vendors. Refs and
 * cursor state survive the detach (renderer-side ids are unaffected), so
 * the next operation reattaches transparently — the only cost is one
 * attach round-trip and a gap in console/network event collection while
 * detached (buffers keep already-captured entries).
 */
export const IDLE_DETACH_TIMEOUT_MS = 60_000;

/** Max DOM.describeNode probes per capture (password detection only). */
const MAX_PASSWORD_PROBES = 20;

export type SnapshotErrorCode =
  | "TAB_NOT_FOUND"
  | "TAB_INVALID_ID"
  | "TAB_NOT_CONTROLLABLE"
  | "DEBUGGER_UNAVAILABLE"
  | "SNAPSHOT_FAILED"
  | "STALE_ELEMENT"
  | "ELEMENT_NOT_INTERACTABLE"
  | "ELEMENT_NOT_EDITABLE"
  | "INVALID_KEY"
  | "INTERACTION_FAILED"
  | "INVALID_TEXT"
  | "EVALUATION_FAILED"
  | "EVALUATION_TIMEOUT"
  | "EVALUATION_RESULT_TOO_LARGE"
  | "SCREENSHOT_FAILED"
  | "SCREENSHOT_TOO_LARGE"
  | "WAIT_TIMEOUT"
  | "WAIT_ABORTED"
  | "OBSERVABILITY_FAILED"
  | "OBSERVABILITY_CONFIG_INVALID";

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;

  constructor(code: SnapshotErrorCode, message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

export interface SnapshotTabRecord {
  readonly id: string;
  readonly url: string;
  readonly title: string;
}

/** Minimal debugger surface the manager needs (adapted from chrome.debugger). */
export interface DebuggerChrome {
  attach(tabId: number): Promise<void>;
  sendCommand(tabId: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  detach(tabId: number): Promise<void>;
  onDetach(listener: (tabId: number | undefined, reason: string) => void): void;
}

export interface SnapshotSessionStorage {
  loadSnapshotSession(): Promise<{ sessionId: string | null; counter: number }>;
  saveSnapshotSession(sessionId: string, counter: number): Promise<void>;
}

export interface SnapshotManagerOptions {
  readonly generateSessionId?: () => string;
}

/** Deterministic controllability gate: only http:/https: are snapshotable. */
export function isSnapshotableSourceUrl(url: string): boolean {
  return /^https?:/i.test(url);
}

/** Bounded pacing sleep for humanized composites (MV3-safe setTimeout). */
function humanizeSleep(ms: number): Promise<void> {
  const clamped = Number.isInteger(ms) && ms > 0 ? Math.min(ms, 2000) : 0;
  if (clamped === 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    setTimeout(resolve, clamped);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExternalDebuggerMessage(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("another debugger") ||
    lowered.includes("already attached") ||
    lowered.includes("debugger is already") ||
    lowered.includes("in use by another")
  );
}

function isTabGoneMessage(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("no tab with id") ||
    lowered.includes("no tab with given id") ||
    lowered.includes("tab not found") ||
    lowered.includes("cannot find tab")
  );
}

function isNotAttachedMessage(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes("not attached") || lowered.includes("not debugging") || lowered.includes("detached");
}

export function generateSnapshotSessionId(randomValues?: (bytes: Uint8Array) => void): string {
  const bytes = new Uint8Array(16);
  if (randomValues !== undefined) {
    randomValues(bytes);
  } else {
    crypto.getRandomValues(bytes);
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isValidSnapshotSessionId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

interface TabSnapshotEntry {
  projectId: string;
  chromeId: number;
  snapshotId: string;
  refs: Map<string, string>;
  url: string;
  /**
   * Last observed cursor position for this tab (viewport CSS px). Drives
   * humanized mouse paths: the next move starts where the cursor actually
   * is instead of teleporting. Survives navigation/detach (the OS cursor
   * does not reset); dropped with the entry on tab close.
   */
  lastMouse?: MousePoint;
}

export interface SnapshotCaptureResult {
  readonly snapshotId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly nodes: SnapshotNode[];
  readonly text: string;
  readonly truncated: boolean;
  readonly totalNodes: number;
  readonly includedNodes: number;
}

/**
 * Small debugger/session manager for page snapshots. Chrome-specific
 * debugger state stays here, extension-side; Node only sees the semantic
 * capture result through the typed `snapshot.capture` RPC.
 */
export class DebuggerSessionManager {
  private readonly owned = new Set<number>();
  private readonly entries = new Map<number, TabSnapshotEntry>();
  /**
   * Owned-session lifecycle per Chrome tab id.
   *
   * DETACHED:  no BrowserMcp-owned attachment; lazy attach allowed.
   * OWNED:     attachment positively owned by this manager; reusable.
   * RETIRING:  an evaluation await-timeout marked this attachment stale;
   *            no attach/reuse until the retirement Promise settles.
   * UNCERTAIN: retirement detach failed/stalled or reconciliation (detach
   *            event, tab removal) invalidated ownership certainty; all
   *            debugger-requiring operations fail DEBUGGER_UNAVAILABLE
   *            until lifecycle evidence (explicit tab removal / fresh
   *            external-detach handling) resets the tab to DETACHED.
   *
   * Late sendCommand settlements never mutate this state; they are only
   * consumed. A stale retirement detach can never tear down a newer
   * attachment because reattachment is blocked until retirement settles.
   */
  private readonly sessionState = new Map<number, "OWNED" | "RETIRING" | "UNCERTAIN">();
  private readonly retireWaiters = new Map<number, Promise<void>>();
  private retireDetachTimeoutMs = RETIRE_DETACH_TIMEOUT_MS;
  /** Last CDP traffic per tab; drives the idle-detach sweep. */
  private readonly lastCdpActivityMs = new Map<number, number>();
  private idleDetachTimeoutMs = IDLE_DETACH_TIMEOUT_MS;
  private sessionId: string | null = null;
  private counter = 0;
  private initialized = false;

  constructor(
    private readonly debuggerChrome: DebuggerChrome,
    private readonly resolveTab: (projectId: string) => Promise<number>,
    private readonly getRecord: (chromeId: number) => SnapshotTabRecord | null,
    private readonly storage: SnapshotSessionStorage | null = null,
    private readonly options: SnapshotManagerOptions = {},
    private readonly getTabStatus?: (chromeId: number) => string,
  ) {
    this.debuggerChrome.onDetach((tabId) => {
      this.handleDetach(tabId);
    });
  }

  /** Test hook: override the bounded retirement-detach deadline. */
  setRetireDetachTimeoutMsForTests(timeoutMs: number): void {
    if (Number.isInteger(timeoutMs) && timeoutMs >= 0) {
      this.retireDetachTimeoutMs = timeoutMs;
    }
  }

  /** Test hook: override the idle-detach lifetime. */
  setIdleDetachTimeoutMsForTests(timeoutMs: number): void {
    if (Number.isInteger(timeoutMs) && timeoutMs >= 0) {
      this.idleDetachTimeoutMs = timeoutMs;
    }
  }

  /** Public debugger-session lifecycle for timeout/retirement tests. */
  debuggerSessionState(chromeId: number): "DETACHED" | "OWNED" | "RETIRING" | "UNCERTAIN" {
    return this.sessionState.get(chromeId) ?? "DETACHED";
  }

  /** True while a timeout retirement is in flight for the tab. */
  isRetiring(chromeId: number): boolean {
    return this.sessionState.get(chromeId) === "RETIRING";
  }

  /** Await an in-flight retirement (tests / serialized callers). */
  async waitForRetirement(chromeId: number): Promise<void> {
    await this.retireWaiters.get(chromeId);
  }

  /** Typed scoped senders bound to the raw debugger transport. */
  private scopedSender<K extends CdpCapability>(
    capability: K,
  ): (chromeId: number, method: CdpCapabilityMethod<K>, params?: Record<string, unknown>) => Promise<Record<string, unknown>> {
    return createScopedCdpSender(capability, (tabId, method, params) =>
      this.rawSend(tabId, method, params),
    );
  }

  private snapshotSend(
    chromeId: number,
    method: CdpCapabilityMethod<"snapshot">,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.scopedSender("snapshot")(chromeId, method, params);
  }

  private interactionSend(
    chromeId: number,
    method: CdpCapabilityMethod<"interaction">,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.scopedSender("interaction")(chromeId, method, params);
  }

  private evaluateSend(
    chromeId: number,
    method: CdpCapabilityMethod<"evaluate">,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.scopedSender("evaluate")(chromeId, method, params);
  }

  private screenshotSend(
    chromeId: number,
    method: CdpCapabilityMethod<"screenshot">,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.scopedSender("screenshot")(chromeId, method, params);
  }

  private waitSend(
    chromeId: number,
    method: CdpCapabilityMethod<"wait">,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.scopedSender("wait")(chromeId, method, params);
  }

  private consoleSend(
    chromeId: number,
    method: CdpCapabilityMethod<"observability-console">,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.scopedSender("observability-console")(chromeId, method, params);
  }

  private networkSend(
    chromeId: number,
    method: CdpCapabilityMethod<"observability-network">,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.scopedSender("observability-network")(chromeId, method, params);
  }

  /** Loading status for load polls; defaults to "complete" when unobserved. */
  private tabStatus(chromeId: number): string {
    try {
      return this.getTabStatus?.(chromeId) ?? "complete";
    } catch {
      return "complete";
    }
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    try {
      const stored = await this.storage?.loadSnapshotSession();
      if (stored !== undefined && stored.sessionId !== null && isValidSnapshotSessionId(stored.sessionId)) {
        this.sessionId = stored.sessionId;
        this.counter = Number.isInteger(stored.counter) && stored.counter >= 0 ? stored.counter : 0;
        return;
      }
    } catch {
      // Ephemeral session below still fails closed (unique per worker).
    }
    this.sessionId = this.options.generateSessionId?.() ?? generateSnapshotSessionId();
    if (!isValidSnapshotSessionId(this.sessionId)) {
      this.sessionId = generateSnapshotSessionId();
    }
    try {
      await this.storage?.saveSnapshotSession(this.sessionId, this.counter);
    } catch {
      // Persistence is best-effort; the in-memory session still scopes refs.
    }
  }

  private requireSession(): string {
    if (this.sessionId === null) {
      throw new SnapshotError("SNAPSHOT_FAILED", "snapshot session is not initialized");
    }
    return this.sessionId;
  }

  private persist(): void {
    const sessionId = this.sessionId;
    if (sessionId === null || this.storage === null) {
      return;
    }
    void this.storage.saveSnapshotSession(sessionId, this.counter).catch(() => undefined);
  }

  isOwned(chromeId: number): boolean {
    return this.owned.has(chromeId);
  }

  ownedCount(): number {
    return this.owned.size;
  }

  /** Latest-snapshot-only validity check. */
  isRefValid(projectTabId: string, ref: string): boolean {
    if (!ELEMENT_REF_PATTERN.test(ref)) {
      return false;
    }
    for (const entry of this.entries.values()) {
      if (entry.projectId === projectTabId && entry.refs.has(ref)) {
        return true;
      }
    }
    return false;
  }

  /** Backend node id behind a live latest-snapshot ref. */
  backendNodeIdForRef(projectTabId: string, ref: string): number | null {
    if (!ELEMENT_REF_PATTERN.test(ref)) {
      return null;
    }
    for (const entry of this.entries.values()) {
      if (entry.projectId === projectTabId && entry.refs.has(ref)) {
        const axNodeId = entry.refs.get(ref);
        return this.axBackendNode(axNodeId ?? null);
      }
    }
    return null;
  }

  private cachedAxNodes: RawAxNode[] | null = null;

  private rememberAxTree(axNodes: RawAxNode[]): void {
    this.cachedAxNodes = axNodes;
  }

  private axBackendNode(axNodeId: string | null): number | null {
    if (axNodeId === null || this.cachedAxNodes === null) {
      return null;
    }
    for (const node of this.cachedAxNodes) {
      if (typeof node.nodeId === "string" && node.nodeId === axNodeId) {
        return typeof node.backendDOMNodeId === "number" && Number.isInteger(node.backendDOMNodeId)
          ? node.backendDOMNodeId
          : null;
      }
    }
    return null;
  }

  /** Resolve a live ref to its internal AX node id; stale/foreign refs throw. */
  resolveRef(projectTabId: string, ref: string): string {
    if (!ELEMENT_REF_PATTERN.test(ref)) {
      throw new SnapshotError("SNAPSHOT_FAILED", `malformed element reference ${JSON.stringify(ref)}`);
    }
    for (const entry of this.entries.values()) {
      if (entry.projectId === projectTabId) {
        const axNodeId = entry.refs.get(ref);
        if (axNodeId !== undefined) {
          return axNodeId;
        }
        throw new SnapshotError(
          "SNAPSHOT_FAILED",
          `element reference ${JSON.stringify(ref)} is stale; capture a fresh snapshot`,
        );
      }
    }
    throw new SnapshotError(
      "SNAPSHOT_FAILED",
      `element reference ${JSON.stringify(ref)} does not belong to tab ${JSON.stringify(projectTabId)}`,
    );
  }

  /** Navigation/reload/history success invalidates refs for the project tab. */
  invalidateTabByProject(projectTabId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.projectId === projectTabId) {
        entry.refs.clear();
      }
    }
  }

  /** External top-level lifecycle observed via tabs.onUpdated.
   *
   * Conservative fail-closed rule: any top-level load commit invalidates
   * refs, even when the URL did not change (external same-URL reload
   * creates a new document). changeInfo.status === "loading" is the
   * reliable signal; a URL change invalidates as well. Title-only updates
   * (no status/url change), tab activation, or unrelated changes do not
   * invalidate. Only snapshot/element refs are cleared; the project TabId
   * itself is owned by TabRegistry and untouched here.
   */
  handleTabUpdated(
    chromeId: number,
    info: { status?: string; url?: string } | string | undefined,
  ): void {
    const entry = this.entries.get(chromeId);
    if (entry === undefined || info === undefined) {
      return;
    }
    const change: { status?: string; url?: string } =
      typeof info === "string" ? { url: info } : info;
    if (change.status === "loading") {
      entry.refs.clear();
      if (change.url !== undefined) {
        entry.url = change.url;
      }
      return;
    }
    if (change.url !== undefined && change.url !== entry.url) {
      entry.refs.clear();
      entry.url = change.url;
    }
  }

  /** Tab close: drop ownership (detach impossible) and invalidate refs. */
  handleTabRemoved(chromeId: number): void {
    this.owned.delete(chromeId);
    this.sessionState.delete(chromeId);
    this.retireWaiters.delete(chromeId);
    this.lastCdpActivityMs.delete(chromeId);
    this.entries.delete(chromeId);
    this.clearObservabilityForChrome(chromeId);
  }

  /** chrome.debugger.onDetach: clear ownership; refs become invalid. */
  handleDetach(chromeId: number | undefined): void {
    if (chromeId === undefined) {
      this.owned.clear();
      // A global detach reconciles every tab: pending retirements converge
      // idempotently to DETACHED instead of hanging in RETIRING/UNCERTAIN.
      this.sessionState.clear();
      this.retireWaiters.clear();
      this.lastCdpActivityMs.clear();
      for (const entry of this.entries.values()) {
        entry.refs.clear();
      }
      // Sanitized buffers stay available (already-redacted entries), but
      // domain-enabled state is cleared for every tab: the next get must
      // re-enable through a safely owned attachment.
      this.clearAllObservabilityDomains();
      return;
    }
    if (this.sessionState.get(chromeId) === "RETIRING") {
      // Converge without breaking serialization: clear ownership and refs,
      // but KEEP the RETIRING state and waiter so concurrent callers stay
      // blocked until the retirement settles. The in-flight retirement
      // detach then either succeeds, fails as already-detached (both
      // converge to DETACHED), or fails/stalls otherwise (UNCERTAIN).
      this.owned.delete(chromeId);
      const entry = this.entries.get(chromeId);
      entry?.refs.clear();
      return;
    }
    // Converge retirement: an external detach outside RETIRING settles the
    // tab as DETACHED (the attachment is already gone; no detach to
    // issue, and reattachment is permitted again). Idempotent by design.
    // Observability domains are disabled; sanitized buffers stay readable.
    this.owned.delete(chromeId);
    this.sessionState.delete(chromeId);
    this.retireWaiters.delete(chromeId);
    this.lastCdpActivityMs.delete(chromeId);
    this.clearObservabilityDomains(chromeId);
    const entry = this.entries.get(chromeId);
    if (entry !== undefined) {
      entry.refs.clear();
    }
  }

  /**
   * Idle sweep: detach positively-owned attachments with no CDP traffic
   * within the idle lifetime. Only OWNED tabs are touched (never foreign,
   * retiring, or uncertain sessions). Snapshot refs, cursor memory, and
   * buffered observability entries survive — only ownership and live
   * event domains are dropped, so the next operation reattaches
   * transparently. Returns the number of tabs detached. The requesting tab
   * is excluded (it is about to be used); pass nothing from the periodic
   * alarm to sweep everything idle.
   */
  async detachIdleTabs(nowMs: number = Date.now(), exceptChromeId?: number): Promise<number> {
    let detached = 0;
    for (const chromeId of [...this.owned]) {
      if (exceptChromeId !== undefined && chromeId === exceptChromeId) {
        continue;
      }
      if (this.sessionState.get(chromeId) !== "OWNED") {
        continue;
      }
      // Attached but never used yet: treat as fresh, never stale.
      const lastActivity = this.lastCdpActivityMs.get(chromeId) ?? nowMs;
      if (nowMs - lastActivity < this.idleDetachTimeoutMs) {
        continue;
      }
      try {
        await this.detachWithTimeout(chromeId, this.retireDetachTimeoutMs);
      } catch {
        // Tab may already be gone; ownership is cleared regardless, same
        // as the shutdown path (a stale record must never pin the infobar).
      }
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      this.lastCdpActivityMs.delete(chromeId);
      // Domain-enabled state must not survive the attachment (sanitized
      // buffers stay readable; the next get re-enables).
      this.clearObservabilityDomains(chromeId);
      detached += 1;
    }
    return detached;
  }

  /** Best-effort release of owned sessions (bridge shutdown path). */
  async detachAllOwned(): Promise<void> {

    const owned = [...this.owned];
    for (const chromeId of owned) {
      if (this.sessionState.get(chromeId) === "RETIRING") {
        // Never tear down a tab mid-retirement; the retirement owns detach.
        continue;
      }
      try {
        await this.debuggerChrome.detach(chromeId);
      } catch {
        // Tab may already be gone; ownership is cleared regardless.
      }
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      this.lastCdpActivityMs.delete(chromeId);
      // The attachment is gone: domain-enabled state must not survive it
      // (sanitized buffers stay readable; the next get re-enables).
      this.clearObservabilityDomains(chromeId);
      const entry = this.entries.get(chromeId);
      if (entry !== undefined) {
        entry.refs.clear();
      }
    }
  }

  async capture(projectTabId: string, maxNodes?: number): Promise<SnapshotCaptureResult> {
    await this.init();
    const sessionId = this.requireSession();
    let chromeId: number;
    try {
      chromeId = await this.resolveTab(projectTabId);
    } catch (error: unknown) {
      throw this.preserveTabError(error, projectTabId);
    }
    const record = this.getRecord(chromeId);
    const url = record?.url ?? "";
    const title = record?.title ?? "";
    if (!isSnapshotableSourceUrl(url)) {
      throw new SnapshotError(
        "TAB_NOT_CONTROLLABLE",
        `tab ${JSON.stringify(projectTabId)} is not a controllable web page and cannot be snapshotted`,
      );
    }

    const previous = this.entries.get(chromeId);
    if (previous !== undefined && previous.projectId !== projectTabId) {
      this.entries.delete(chromeId);
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
    }

    await this.ensureAttached(chromeId, projectTabId);

    let axNodes: RawAxNode[];
    try {
      axNodes = await this.collectAxTree(chromeId);
    } catch (error: unknown) {
      throw this.commandFailure(chromeId, projectTabId, error);
    }
    this.rememberAxTree(axNodes);

    let valueSafety: Map<number, "safe" | "password">;
    try {
      valueSafety = await this.classifyEditableValues(chromeId, axNodes);
    } catch {
      // Fail closed: an empty safety map redacts every editable value.
      valueSafety = new Map();
    }
    this.lastValueSafety = valueSafety;

    const snapCounter = this.counter;
    const snapshotId = `s-${sessionId}-${snapCounter.toString(36)}`;
    const refByAxNode = new Map<string, string>();
    let refCounter = 0;
    const allocateRef = (axNodeId: string): string | null => {
      const existing = refByAxNode.get(axNodeId);
      if (existing !== undefined) {
        return existing;
      }
      refCounter += 1;
      const ref = `e-${sessionId}-${snapCounter.toString(36)}-${refCounter.toString(36)}`;
      refByAxNode.set(axNodeId, ref);
      return ref;
    };
    const normalizeOptions: NormalizeOptions = {
      allocateRef: (axNodeId) => allocateRef(axNodeId),
      valueSafety,
      ...(maxNodes === undefined ? {} : { maxNodes }),
      envelope: { snapshotId, tabId: projectTabId, url, title },
      maxSerializedBytes: SNAPSHOT_MAX_SERIALIZED_BYTES,
    };
    const normalized = normalizeAxTree(axNodes, normalizeOptions);

    this.counter = snapCounter + 1;
    this.persist();
    const refs = new Map<string, string>();
    const liveRefs = new Set<string>();
    for (const node of normalized.nodes) {
      if (node.ref !== undefined) {
        liveRefs.add(node.ref);
      }
    }
    for (const [axNodeId, ref] of refByAxNode) {
      // Only publish refs for nodes that survived filtering/bounds: every
      // allocated ref is live by construction, except refs whose node was
      // dropped by the node cap (allocated during traversal). Those fail
      // closed via latest-snapshot-only semantics.
      if (liveRefs.has(ref)) {
        refs.set(ref, axNodeId);
      }
    }
    this.entries.set(chromeId, { projectId: projectTabId, chromeId, snapshotId, refs, url });

    return {
      snapshotId,
      tabId: projectTabId,
      url,
      title,
      nodes: normalized.nodes,
      text: normalized.text,
      truncated: normalized.truncated,
      totalNodes: normalized.totalNodes,
      includedNodes: normalized.includedNodes,
    };
  }

  private preserveTabError(error: unknown, projectTabId: string): SnapshotError {
    const code = (error as { code?: unknown }).code;
    if (code === "TAB_INVALID_ID") {
      return new SnapshotError("TAB_INVALID_ID", `unknown tab reference ${JSON.stringify(projectTabId)}`);
    }
    return new SnapshotError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectTabId)} no longer exists`);
  }

  // Element interactions. Every operation resolves its opaque
  // latest-snapshot-only ref extension-side (never by Node-supplied CDP
  // ids), reuses the owned debugger session (never steals a foreign one),
  // and sends only allowlisted DOM/Input/Accessibility commands (never
  // Runtime). Mutating successes invalidate the tab's refs; pure reads do
  // not. Failures before any input dispatch leave refs untouched.

  /**
   * Shared interaction preamble: selected project tab match, live latest
   * ref, controllable source URL, owned debugger session. Returns the
   * resolved (chromeId, backendNodeId) pair; text payloads are validated
   * (byte limit) before any debugger traffic, and length-only failures
   * never echo the payload.
   */
  private async beginInteraction(
    projectTabId: string,
    ref: string,
    text?: string,
  ): Promise<{ chromeId: number; backendNodeId: number; nodeId: string }> {
    let chromeId: number;
    try {
      chromeId = await this.resolveTab(projectTabId);
    } catch (error: unknown) {
      throw this.preserveTabError(error, projectTabId);
    }
    const entry = this.entries.get(chromeId);
    if (entry === undefined || entry.projectId !== projectTabId) {
      throw new SnapshotError(
        "STALE_ELEMENT",
        `element reference ${JSON.stringify(ref)} does not belong to tab ${JSON.stringify(projectTabId)}`,
      );
    }
    const nodeId = entry.refs.get(ref);
    if (nodeId === undefined) {
      if (!ELEMENT_REF_PATTERN.test(ref)) {
        throw new SnapshotError("SNAPSHOT_FAILED", `malformed element reference ${JSON.stringify(ref)}`);
      }
      throw new SnapshotError(
        "STALE_ELEMENT",
        `element reference ${JSON.stringify(ref)} is stale; capture a fresh snapshot`,
      );
    }
    if (text !== undefined && utf8ByteLength(text) > INTERACTION_TEXT_LIMIT_BYTES) {
      throw new SnapshotError(
        "INVALID_TEXT",
        `text exceeds the ${String(INTERACTION_TEXT_LIMIT_BYTES)} UTF-8 byte limit`,
      );
    }
    const record = this.getRecord(chromeId);
    const url = record?.url ?? "";
    if (!isSnapshotableSourceUrl(url)) {
      throw new SnapshotError(
        "TAB_NOT_CONTROLLABLE",
        `tab ${JSON.stringify(projectTabId)} is not a controllable web page`,
      );
    }
    const backendNodeId = this.axBackendNode(nodeId);
    if (backendNodeId === null) {
      throw new SnapshotError(
        "STALE_ELEMENT",
        `element reference ${JSON.stringify(ref)} is stale; capture a fresh snapshot`,
      );
    }
    await this.ensureAttached(chromeId, projectTabId);
    return { chromeId, backendNodeId, nodeId };
  }

  private staleFromCommand(chromeId: number, projectTabId: string, error: unknown): SnapshotError {
    const message = errorMessage(error);
    if (isTabGoneMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      this.entries.delete(chromeId);
      return new SnapshotError(
        "STALE_ELEMENT",
        `element reference no longer exists in tab ${JSON.stringify(projectTabId)}`,
      );
    }
    if (isNotAttachedMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      const entry = this.entries.get(chromeId);
      entry?.refs.clear();
    }
    const code = (error as { code?: unknown }).code;
    if (code === "TAB_NOT_FOUND" || code === "TAB_INVALID_ID") {
      return new SnapshotError(
        "STALE_ELEMENT",
        `element reference no longer exists in tab ${JSON.stringify(projectTabId)}`,
      );
    }
    return new SnapshotError("INTERACTION_FAILED", `interaction failed: ${message.slice(0, 200)}`);
  }

  /** Positively classify the target control; file inputs are unsupported. */
  private async classifyControl(
    chromeId: number,
    backendNodeId: number,
  ): Promise<{ nodeName: string; type: string | null; attributes: string[] }> {
    await this.interactionSend(chromeId, "DOM.enable");
    const described = await this.interactionSend(chromeId, "DOM.describeNode", { backendNodeId });
    const node = described["node"];
    if (!isRecord(node)) {
      throw new SnapshotError("INTERACTION_FAILED", "the target element no longer exists");
    }
    const nodeName = typeof node["nodeName"] === "string" ? (node["nodeName"] as string).toLowerCase() : "";
    const attributes = Array.isArray(node["attributes"])
      ? (node["attributes"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [];
    let typeValue: string | null = null;
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      if (attributes[index]?.toLowerCase() === "type") {
        typeValue = (attributes[index + 1] ?? "").toLowerCase();
        break;
      }
    }
    return { nodeName, type: typeValue, attributes };
  }

  private static isFileControl(info: { nodeName: string; type: string | null }): boolean {
    return info.nodeName === "input" && info.type === "file";
  }

  private static isEditableControl(info: { nodeName: string; type: string | null; attributes?: string[] }): boolean {
    if (info.nodeName === "textarea") {
      return true;
    }
    if (info.nodeName === "input" && info.type !== null) {
      // Text-entry semantics: text-like types only. input[type=number]
      // is NOT an approved fill/type target and falls through to
      // the typed ELEMENT_NOT_EDITABLE error.
      return (
        info.type === "text" ||
        info.type === "search" ||
        info.type === "email" ||
        info.type === "tel" ||
        info.type === "url" ||
        info.type === "password"
      );
    }
    // Rich editors (Discord/Slack slate, Gmail compose): div/span with
    // contenteditable=true and textbox semantics. Attributes come from
    // DOM.describeNode as [name, value, ...].
    const attrs = info.attributes ?? [];
    for (let index = 0; index + 1 < attrs.length; index += 2) {
      if (attrs[index]?.toLowerCase() === "contenteditable" && attrs[index + 1]?.toLowerCase() === "true") {
        return true;
      }
    }
    return false;
  }

  /** Scroll into view, then return a finite non-zero click point. */
  private async clickPoint(
    chromeId: number,
    backendNodeId: number,
  ): Promise<{ x: number; y: number }> {
    const box = await this.clickBox(chromeId, backendNodeId);
    return { x: box.x, y: box.y };
  }

  /**
   * Scroll into view, then return the click box: center plus bounds. The
   * humanized path jitters inside the bounds; the instant path uses the
   * exact center (unchanged legacy behavior).
   */
  private async clickBox(
    chromeId: number,
    backendNodeId: number,
  ): Promise<{ x: number; y: number; minX: number; minY: number; maxX: number; maxY: number }> {
    await this.interactionSend(chromeId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    const quads = await this.interactionSend(chromeId, "DOM.getContentQuads", { backendNodeId });
    const raw = quads["quads"];
    // CDP returns { quads: [...] }; some harnesses/fixtures nest one level
    // deeper ({ quads: [[quad]] }). Accept both shapes.
    const candidates: unknown[] = Array.isArray(raw)
      ? raw.length === 1 && Array.isArray(raw[0]) && raw[0].length > 0 && Array.isArray((raw[0] as unknown[])[0])
        ? (raw[0] as unknown[])
        : raw
      : [];
    if (candidates.length === 0) {
      throw new SnapshotError("ELEMENT_NOT_INTERACTABLE", "the target has no visible geometry");
    }
    for (const entry of candidates) {
      if (!Array.isArray(entry) || entry.length < 8) {
        continue;
      }
      const coords = (entry as unknown[]).map((value) => (typeof value === "number" ? value : NaN));
      if (coords.some((value) => !Number.isFinite(value))) {
        continue;
      }
      const xs = [coords[0] ?? NaN, coords[2] ?? NaN, coords[4] ?? NaN, coords[6] ?? NaN];
      const ys = [coords[1] ?? NaN, coords[3] ?? NaN, coords[5] ?? NaN, coords[7] ?? NaN];
      if (xs.some((value) => !Number.isFinite(value)) || ys.some((value) => !Number.isFinite(value))) {
        continue;
      }
      const minX = Math.min(...(xs as number[]));
      const maxX = Math.max(...(xs as number[]));
      const minY = Math.min(...(ys as number[]));
      const maxY = Math.max(...(ys as number[]));
      if (!(maxX > minX) || !(maxY > minY)) {
        continue;
      }
      return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, minX, minY, maxX, maxY };
    }
    throw new SnapshotError("ELEMENT_NOT_INTERACTABLE", "the target has no usable visible geometry");
  }

  /**
   * Humanized click replay: neuromotor path from the last observed cursor
   * position, hover dwell, press-hold, release. All coordinates are rounded
   * to integers (real mouse events never carry sub-pixel positions).
   * Updates the tab's lastMouse so the next move starts truthfully.
   */
  private async replayHumanClick(
    chromeId: number,
    mouseState: { lastMouse?: MousePoint },
    box: { x: number; y: number; minX: number; minY: number; maxX: number; maxY: number },
  ): Promise<void> {
    const rng: HumanRng = Math.random;
    const end = jitterClickPoint(box, rng);
    const from = mouseState.lastMouse ?? { x: end.x - 160, y: end.y - 90 };
    const width = Math.max(box.maxX - box.minX, box.maxY - box.minY);
    const plan = planMouseMove(from, end, width, rng);
    for (const point of plan.points) {
      await this.interactionSend(chromeId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(point.x),
        y: Math.round(point.y),
        button: "none",
        clickCount: 0,
      });
      if (point.dtMs > 0) {
        await humanizeSleep(point.dtMs);
      }
    }
    mouseState.lastMouse = { x: end.x, y: end.y };
    await humanizeSleep(hoverDwellMs(rng));
    const x = Math.round(end.x);
    const y = Math.round(end.y);
    await this.interactionSend(chromeId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await humanizeSleep(pressHoldMs(rng));
    await this.interactionSend(chromeId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  /** Clear editable content through real keyboard mechanics (no Runtime). */
  private async clearEditable(chromeId: number): Promise<void> {
    await this.interactionSend(chromeId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2,
    });
    await this.interactionSend(chromeId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2,
    });
    await this.interactionSend(chromeId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await this.interactionSend(chromeId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
  }

  async clickElement(projectTabId: string, ref: string, humanize = false): Promise<{ clicked: true }> {
    const { chromeId, backendNodeId } = await this.beginInteraction(projectTabId, ref);
    try {
      let info: { nodeName: string; type: string | null; attributes: string[] };
      try {
        info = await this.classifyControl(chromeId, backendNodeId);
      } catch (error: unknown) {
        throw this.staleFromCommand(chromeId, projectTabId, error);
      }
      if (DebuggerSessionManager.isFileControl(info)) {
        throw new SnapshotError(
          "ELEMENT_NOT_INTERACTABLE",
          "file inputs cannot be clicked (no OS file picker is available)",
        );
      }
      if (humanize !== true) {
        const point = await this.clickPoint(chromeId, backendNodeId);
        try {
          await this.interactionSend(chromeId, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: point.x,
            y: point.y,
            button: "none",
            clickCount: 0,
          });
          await this.interactionSend(chromeId, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: point.x,
            y: point.y,
            button: "left",
            clickCount: 1,
          });
          await this.interactionSend(chromeId, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: point.x,
            y: point.y,
            button: "left",
            clickCount: 1,
          });
        } catch (error: unknown) {
          throw this.staleFromCommand(chromeId, projectTabId, error);
        }
        const stored = this.entries.get(chromeId);
        if (stored !== undefined) {
          stored.lastMouse = { x: point.x, y: point.y };
        }
      } else {
        const box = await this.clickBox(chromeId, backendNodeId);
        try {
          const stored = this.entries.get(chromeId);
          await this.replayHumanClick(chromeId, stored ?? {}, box);
        } catch (error: unknown) {
          throw this.staleFromCommand(chromeId, projectTabId, error);
        }
      }
    } catch (error: unknown) {
      if (error instanceof SnapshotError) {
        throw error;
      }
      throw this.staleFromCommand(chromeId, projectTabId, error);
    }
    this.invalidateTabByProject(projectTabId);
    return { clicked: true };
  }

  async fillElement(projectTabId: string, ref: string, text: string): Promise<{ filled: true }> {
    const { chromeId, backendNodeId } = await this.beginInteraction(projectTabId, ref, text);
    try {
      let info: { nodeName: string; type: string | null; attributes: string[] };
      try {
        info = await this.classifyControl(chromeId, backendNodeId);
      } catch (error: unknown) {
        throw this.staleFromCommand(chromeId, projectTabId, error);
      }
      if (DebuggerSessionManager.isFileControl(info)) {
        throw new SnapshotError(
          "ELEMENT_NOT_EDITABLE",
          "file inputs cannot be filled (file upload is not supported)",
        );
      }
      if (!DebuggerSessionManager.isEditableControl(info)) {
        throw new SnapshotError("ELEMENT_NOT_EDITABLE", "the target is not an editable text control");
      }
      try {
        await this.interactionSend(chromeId, "DOM.focus", { backendNodeId });
        await this.clearEditable(chromeId);
        await this.interactionSend(chromeId, "Input.insertText", { text });
      } catch (error: unknown) {
        throw this.staleFromCommand(chromeId, projectTabId, error);
      }
    } catch (error: unknown) {
      if (error instanceof SnapshotError) {
        throw error;
      }
      throw this.staleFromCommand(chromeId, projectTabId, error);
    }
    this.invalidateTabByProject(projectTabId);
    return { filled: true };
  }

  async typeIntoElement(projectTabId: string, ref: string, text: string): Promise<{ typed: true }> {
    const { chromeId, backendNodeId } = await this.beginInteraction(projectTabId, ref, text);
    try {
      let info: { nodeName: string; type: string | null; attributes: string[] };
      try {
        info = await this.classifyControl(chromeId, backendNodeId);
      } catch (error: unknown) {
        throw this.staleFromCommand(chromeId, projectTabId, error);
      }
      if (DebuggerSessionManager.isFileControl(info)) {
        throw new SnapshotError(
          "ELEMENT_NOT_EDITABLE",
          "file inputs cannot be typed into (file upload is not supported)",
        );
      }
      if (!DebuggerSessionManager.isEditableControl(info)) {
        throw new SnapshotError("ELEMENT_NOT_EDITABLE", "the target is not an editable text control");
      }
      try {
        await this.interactionSend(chromeId, "DOM.focus", { backendNodeId });
        await this.interactionSend(chromeId, "Input.insertText", { text });
      } catch (error: unknown) {
        throw this.staleFromCommand(chromeId, projectTabId, error);
      }
    } catch (error: unknown) {
      if (error instanceof SnapshotError) {
        throw error;
      }
      throw this.staleFromCommand(chromeId, projectTabId, error);
    }
    this.invalidateTabByProject(projectTabId);
    return { typed: true };
  }

  async pressKeyOnTab(projectTabId: string, rawKey: string): Promise<{ pressed: true }> {
    let chromeId: number;
    try {
      chromeId = await this.resolveTab(projectTabId);
    } catch (error: unknown) {
      throw this.preserveTabError(error, projectTabId);
    }
    const parsed = parsePressKey(rawKey);
    if ("error" in parsed) {
      throw new SnapshotError("INVALID_KEY", `unsupported key ${JSON.stringify(rawKey)}`);
    }
    const record = this.getRecord(chromeId);
    const url = record?.url ?? "";
    if (!isSnapshotableSourceUrl(url)) {
      throw new SnapshotError(
        "TAB_NOT_CONTROLLABLE",
        `tab ${JSON.stringify(projectTabId)} is not a controllable web page`,
      );
    }
    await this.ensureAttached(chromeId, projectTabId);
    const base = {
      key: parsed.key,
      code: parsed.code,
      windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
      nativeVirtualKeyCode: parsed.windowsVirtualKeyCode,
      modifiers: parsed.modifiers,
    };
    try {
      if (parsed.key.length === 1 && !parsed.control && !parsed.meta && !parsed.alt) {
        await this.interactionSend(chromeId, "Input.dispatchKeyEvent", { ...base, type: "char", text: parsed.key });
      } else {
        await this.interactionSend(chromeId, "Input.dispatchKeyEvent", { ...base, type: "keyDown" });
        await this.interactionSend(chromeId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
      }
    } catch (error: unknown) {
      throw this.staleFromCommand(chromeId, projectTabId, error);
    }
    this.invalidateTabByProject(projectTabId);
    return { pressed: true };
  }

  private async dispatchParsedKey(chromeId: number, projectTabId: string, rawKey: string): Promise<void> {
    const parsed = parsePressKey(rawKey);
    if ("error" in parsed) {
      throw new SnapshotError("INVALID_KEY", "unsupported key in sequence");
    }
    const base = {
      key: parsed.key,
      code: parsed.code,
      windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
      nativeVirtualKeyCode: parsed.windowsVirtualKeyCode,
      modifiers: parsed.modifiers,
    };
    try {
      if (parsed.key.length === 1 && !parsed.control && !parsed.meta && !parsed.alt) {
        await this.interactionSend(chromeId, "Input.dispatchKeyEvent", { ...base, type: "char", text: parsed.key });
      } else {
        await this.interactionSend(chromeId, "Input.dispatchKeyEvent", { ...base, type: "keyDown" });
        await this.interactionSend(chromeId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
      }
    } catch (error: unknown) {
      throw this.staleFromCommand(chromeId, projectTabId, error);
    }
  }

  private async requireEditable(chromeId: number, backendNodeId: number, projectTabId: string): Promise<void> {
    let info: { nodeName: string; type: string | null; attributes: string[] };
    try {
      info = await this.classifyControl(chromeId, backendNodeId);
    } catch (error: unknown) {
      throw this.staleFromCommand(chromeId, projectTabId, error);
    }
    if (DebuggerSessionManager.isFileControl(info)) {
      throw new SnapshotError("ELEMENT_NOT_EDITABLE", "file inputs cannot receive humanized input");
    }
    if (!DebuggerSessionManager.isEditableControl(info)) {
      throw new SnapshotError("ELEMENT_NOT_EDITABLE", "the target is not an editable text control");
    }
  }

  /**
   * Humanized typing: focus once, then insert text in small chunks with
   * WPM-derived pacing (one bridge call -> many CDP inserts). Reuses only
   * the existing interaction allowlist (DOM.focus, Input.insertText).
   */
  async typeHumanElement(
    projectTabId: string,
    ref: string,
    text: string,
    wpm?: number,
    mode: HumanTypeMode = "keys",
  ): Promise<{ typed: true }> {
    const effectiveWpm = normalizeWpm(wpm);
    if (effectiveWpm === null) {
      throw new SnapshotError("INVALID_TEXT", "wpm is outside the 20-200 range");
    }
    if (normalizeHumanTypeMode(mode) === null) {
      throw new SnapshotError("INVALID_TEXT", "mode must be keys or insert");
    }
    if (mode === "keys" && Array.from(text).length > HUMAN_KEYS_MODE_MAX_CHARS) {
      throw new SnapshotError(
        "INVALID_TEXT",
        `keys mode accepts at most ${String(HUMAN_KEYS_MODE_MAX_CHARS)} characters`,
      );
    }
    void HUMANIZE_WPM_MIN;
    void HUMANIZE_WPM_MAX;
    const { chromeId, backendNodeId } = await this.beginInteraction(projectTabId, ref, text);
    try {
      let info: { nodeName: string; type: string | null; attributes: string[] };
      try {
        info = await this.classifyControl(chromeId, backendNodeId);
      } catch (error: unknown) {
        throw this.staleFromCommand(chromeId, projectTabId, error);
      }
      if (DebuggerSessionManager.isFileControl(info)) {
        throw new SnapshotError("ELEMENT_NOT_EDITABLE", "file inputs cannot receive humanized input");
      }
      if (!DebuggerSessionManager.isEditableControl(info)) {
        throw new SnapshotError("ELEMENT_NOT_EDITABLE", "the target is not an editable text control");
      }
      // Passwords always use inserts: key-event timing on secrets adds
      // no stealth and widens the observable surface.
      const isPassword = info.type === "password";
      try {
        await this.humanTypeText(chromeId, projectTabId, backendNodeId, text, effectiveWpm, mode, isPassword);
      } catch (error: unknown) {
        if (error instanceof SnapshotError) {
          throw error;
        }
        throw this.staleFromCommand(chromeId, projectTabId, error);
      }
    } catch (error: unknown) {
      if (error instanceof SnapshotError) {
        throw error;
      }
      throw this.staleFromCommand(chromeId, projectTabId, error);
    }
    this.invalidateTabByProject(projectTabId);
    return { typed: true };
  }

  /**
   * Shared keystroke engine for typeHuman/clickType. Keys mode emits real
   * per-character key events (keydown/dwell/keyup) with lognormal flight
   * timing; insert mode replays the same rhythm model through chunked
   * insertText (no key-event trail, but faster).
   */
  private async humanTypeText(
    chromeId: number,
    projectTabId: string,
    backendNodeId: number,
    text: string,
    wpm: number,
    mode: HumanTypeMode,
    isPassword: boolean,
  ): Promise<void> {
    const rng: HumanRng = Math.random;
    await this.interactionSend(chromeId, "DOM.focus", { backendNodeId });
    if (mode !== "keys" || isPassword) {
      const chunks = planInsertChunks(text, wpm, rng);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        if (chunk === undefined || chunk.text.length === 0) {
          continue;
        }
        await this.interactionSend(chromeId, "Input.insertText", { text: chunk.text });
        if (index + 1 < chunks.length && chunk.delayMs > 0) {
          await humanizeSleep(chunk.delayMs);
        }
      }
      return;
    }
    const keystrokes = planKeystrokes(text, wpm, rng);
    let first = true;
    for (const entry of keystrokes) {
      if (first) {
        // Brief focus settle before the first key, never zero.
        await humanizeSleep(30 + rng() * 50);
        first = false;
      } else if (entry.flightMs > 0) {
        await humanizeSleep(entry.flightMs);
      }
      await this.dispatchHumanKey(chromeId, projectTabId, entry.char, entry.dwellMs);
    }
  }

  /**
   * One human keystroke: real keyDown/dwell/keyUp. Printable characters
   * carry text on keyDown (the browser inserts them, as with a physical
   * keyboard); Enter submits newlines; anything the key allowlist rejects
   * (emoji, CJK, controls) falls back to a single insertText.
   */
  private async dispatchHumanKey(
    chromeId: number,
    projectTabId: string,
    char: string,
    dwellMs: number,
  ): Promise<void> {
    if (char === "\n") {
      await this.dispatchParsedKey(chromeId, projectTabId, "Enter");
      return;
    }
    const parsed = parsePressKey(char);
    if ("error" in parsed || parsed.control || parsed.meta || parsed.alt) {
      await this.interactionSend(chromeId, "Input.insertText", { text: char });
      return;
    }
    const base = {
      key: parsed.key,
      code: parsed.code,
      windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
      nativeVirtualKeyCode: parsed.windowsVirtualKeyCode,
      modifiers: parsed.modifiers,
    };
    try {
      await this.interactionSend(chromeId, "Input.dispatchKeyEvent", { ...base, type: "keyDown", text: char });
      if (dwellMs > 0) {
        await humanizeSleep(dwellMs);
      }
      await this.interactionSend(chromeId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    } catch (error: unknown) {
      throw this.staleFromCommand(chromeId, projectTabId, error);
    }
  }

  /**
   * Press a bounded sequence of keys with inter-key pacing (one bridge
   * call -> many dispatchKeyEvent pairs). Tab-scoped, no ref needed.
   */
  async pressSequenceOnTab(projectTabId: string, keys: string[], delayMs?: number): Promise<{ pressed: true }> {
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > PRESS_SEQUENCE_MAX_KEYS) {
      throw new SnapshotError("INVALID_KEY", "key sequence must contain 1-50 keys");
    }
    const effectiveDelay = normalizeSequenceDelayMs(delayMs);
    if (effectiveDelay === null) {
      throw new SnapshotError("INVALID_KEY", "sequence delay is outside the 0-2000ms range");
    }
    void HUMANIZE_SEQUENCE_DELAY_MIN_MS;
    void HUMANIZE_SEQUENCE_DELAY_MAX_MS;
    let chromeId: number;
    try {
      chromeId = await this.resolveTab(projectTabId);
    } catch (error: unknown) {
      throw this.preserveTabError(error, projectTabId);
    }
    for (const key of keys) {
      if (typeof key !== "string" || "error" in parsePressKey(key)) {
        throw new SnapshotError("INVALID_KEY", "unsupported key in sequence");
      }
    }
    const record = this.getRecord(chromeId);
    const url = record?.url ?? "";
    if (!isSnapshotableSourceUrl(url)) {
      throw new SnapshotError(
        "TAB_NOT_CONTROLLABLE",
        `tab ${JSON.stringify(projectTabId)} is not a controllable web page`,
      );
    }
    await this.ensureAttached(chromeId, projectTabId);
    for (let index = 0; index < keys.length; index += 1) {
      await this.dispatchParsedKey(chromeId, projectTabId, keys[index] as string);
      if (index + 1 < keys.length && effectiveDelay > 0) {
        await humanizeSleep(effectiveDelay);
      }
    }
    this.invalidateTabByProject(projectTabId);
    return { pressed: true };
  }

  /**
   * Click-then-type composite: real mouse click, focus, then instant or
   * humanized typing plus an optional submit key — the login/search flow
   * in one bridge call. Humanize enables the neuromotor mouse path and
   * keystroke pacing; otherwise the click is instant and the text inserts
   * in one shot. Reuses clickBox + focus + the shared typing engine only.
   */
  async clickTypeElement(
    projectTabId: string,
    ref: string,
    text: string,
    options?: { humanize?: boolean; wpm?: number; mode?: HumanTypeMode; submitKey?: string },
  ): Promise<{ typed: true }> {
    const humanize = options?.humanize ?? true;
    const effectiveWpm = normalizeWpm(options?.wpm);
    if (effectiveWpm === null) {
      throw new SnapshotError("INVALID_TEXT", "wpm is outside the 20-200 range");
    }
    const mode = normalizeHumanTypeMode(options?.mode);
    if (mode === null) {
      throw new SnapshotError("INVALID_TEXT", "mode must be keys or insert");
    }
    if (humanize && mode === "keys" && Array.from(text).length > HUMAN_KEYS_MODE_MAX_CHARS) {
      throw new SnapshotError(
        "INVALID_TEXT",
        `keys mode accepts at most ${String(HUMAN_KEYS_MODE_MAX_CHARS)} characters`,
      );
    }
    if (options?.submitKey !== undefined && ("error" in parsePressKey(options.submitKey) || typeof options.submitKey !== "string")) {
      throw new SnapshotError("INVALID_KEY", "unsupported submit key");
    }
    void HUMANIZE_WPM_DEFAULT;
    const { chromeId, backendNodeId } = await this.beginInteraction(projectTabId, ref, text);
    try {
      let info: { nodeName: string; type: string | null; attributes: string[] };
      try {
        info = await this.classifyControl(chromeId, backendNodeId);
      } catch (error: unknown) {
        throw this.staleFromCommand(chromeId, projectTabId, error);
      }
      if (DebuggerSessionManager.isFileControl(info)) {
        throw new SnapshotError("ELEMENT_NOT_EDITABLE", "file inputs cannot be click-typed");
      }
      if (!humanize) {
        const point = await this.clickPoint(chromeId, backendNodeId);
        try {
          await this.interactionSend(chromeId, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: point.x,
            y: point.y,
            button: "none",
            clickCount: 0,
          });
          await this.interactionSend(chromeId, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: point.x,
            y: point.y,
            button: "left",
            clickCount: 1,
          });
          await this.interactionSend(chromeId, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: point.x,
            y: point.y,
            button: "left",
            clickCount: 1,
          });
        } catch (error: unknown) {
          throw this.staleFromCommand(chromeId, projectTabId, error);
        }
        const stored = this.entries.get(chromeId);
        if (stored !== undefined) {
          stored.lastMouse = { x: point.x, y: point.y };
        }
      } else {
        const box = await this.clickBox(chromeId, backendNodeId);
        try {
          const stored = this.entries.get(chromeId);
          await this.replayHumanClick(chromeId, stored ?? {}, box);
        } catch (error: unknown) {
          throw this.staleFromCommand(chromeId, projectTabId, error);
        }
      }
      try {
        await this.requireEditable(chromeId, backendNodeId, projectTabId);
      } catch (error: unknown) {
        if (error instanceof SnapshotError) {
          throw error;
        }
        throw this.staleFromCommand(chromeId, projectTabId, error);
      }
      try {
        const isPassword = info.type === "password";
        if (!humanize) {
          await this.interactionSend(chromeId, "DOM.focus", { backendNodeId });
          await this.interactionSend(chromeId, "Input.insertText", { text });
        } else {
          await this.humanTypeText(chromeId, projectTabId, backendNodeId, text, effectiveWpm, mode, isPassword);
        }
        if (options?.submitKey !== undefined) {
          await this.dispatchParsedKey(chromeId, projectTabId, options.submitKey);
        }
      } catch (error: unknown) {
        if (error instanceof SnapshotError) {
          throw error;
        }
        throw this.staleFromCommand(chromeId, projectTabId, error);
      }
    } catch (error: unknown) {
      if (error instanceof SnapshotError) {
        throw error;
      }
      throw this.staleFromCommand(chromeId, projectTabId, error);
    }
    this.invalidateTabByProject(projectTabId);
    return { typed: true };
  }

  /**
   * Fresh semantic read of a live element (read-only: never invalidates).
   * Prefers Accessibility.getPartialAXTree on the internal backend node;
   * falls back to getFullAXTree + internal lookup. Password/protected /
   * uncertain editable values stay redacted under the fail-closed
   * model.
   */
  async getElementText(
    projectTabId: string,
    ref: string,
  ): Promise<{ text: string; role: string; source: "accessibility" }> {
    const { chromeId, backendNodeId } = await this.beginInteraction(projectTabId, ref);
    let axSubset: RawAxNode[];
    try {
      axSubset = await this.readPartialAxTree(chromeId, backendNodeId);
    } catch (error: unknown) {
      throw this.staleFromCommand(chromeId, projectTabId, error);
    }
    const nodeText = this.semanticTextForBackendNode(axSubset, backendNodeId);
    if (nodeText === null) {
      throw new SnapshotError(
        "STALE_ELEMENT",
        `element reference ${JSON.stringify(ref)} is stale; capture a fresh snapshot`,
      );
    }
    return { text: nodeText.text, role: nodeText.role, source: "accessibility" };
  }

  private async readPartialAxTree(chromeId: number, backendNodeId: number): Promise<RawAxNode[]> {
    await this.interactionSend(chromeId, "Accessibility.enable");
    try {
      const partial = await this.interactionSend(chromeId, "Accessibility.getPartialAXTree", {
        backendNodeId,
        fetchRelatives: false,
      });
      const nodes = partial["nodes"];
      if (Array.isArray(nodes) && nodes.length > 0) {
        const raw: RawAxNode[] = [];
        for (const node of nodes) {
          if (isRecord(node)) {
            raw.push(node);
          }
        }
        if (raw.length > 0) {
          return raw;
        }
      }
    } catch {
      // Fall through to the getFullAXTree fallback below.
    }
    const tree = await this.interactionSend(chromeId, "Accessibility.getFullAXTree", {});
    const nodes = tree["nodes"];
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new SnapshotError("SNAPSHOT_FAILED", "the page exposed no accessible nodes");
    }
    const raw: RawAxNode[] = [];
    for (const node of nodes) {
      if (isRecord(node)) {
        raw.push(node);
      }
    }
    return raw;
  }

  private semanticTextForBackendNode(
    axNodes: RawAxNode[],
    backendNodeId: number,
  ): { text: string; role: string } | null {
    let target: RawAxNode | null = null;
    for (const node of axNodes) {
      if (node.backendDOMNodeId === backendNodeId) {
        target = node;
        break;
      }
    }
    if (target === null) {
      // Partial tree without backend ids (or a backend-id-less subset):
      // use the first node as the semantic target when the subset is
      // precisely the element query result.
      if (axNodes.length === 1 && axNodes[0] !== undefined) {
        target = axNodes[0];
      } else {
        return null;
      }
    }
    const rawRole = typeof target.role === "string"
      ? target.role
      : isRecord(target.role) && typeof target.role["value"] === "string"
        ? (target.role["value"] as string)
        : "";
    const role = rawRole.trim().toLowerCase() === "statictext" ? "text" : rawRole.trim().toLowerCase() || "group";
    const name = typeof target.name === "string"
      ? target.name
      : isRecord(target.name) && typeof target.name["value"] === "string"
        ? (target.name["value"] as string)
        : "";
    const value = typeof target.value === "string"
      ? target.value
      : isRecord(target.value) && typeof target.value["value"] === "string"
        ? (target.value["value"] as string)
        : "";
    const description = typeof target.description === "string"
      ? target.description
      : isRecord(target.description) && typeof target.description["value"] === "string"
        ? (target.description["value"] as string)
        : "";
    // Editable controls: expose the value ONLY when the interaction-time
    // probe positively established non-password input; every other
    // editable value (password, unknown, unprobed) stays redacted.
    const editable = new Set(["textbox", "searchbox", "spinbutton", "combobox"]);
    if (editable.has(rawRole.trim().toLowerCase())) {
      const probes = this.cachedValueSafety();
      const safety = probes.get(backendNodeId);
      if (safety === "safe") {
        return { text: value.trim() || name.trim(), role };
      }
      return { text: name.trim(), role };
    }
    const text = [name.trim(), value.trim(), description.trim()].filter((part) => part !== "").join(" ").trim();
    return { text, role };
  }

  /** Snapshot of the last fail-closed value-safety classification. */
  private cachedValueSafety(): Map<number, "safe" | "password"> {
    return this.lastValueSafety ?? new Map();
  }

  private lastValueSafety: Map<number, "safe" | "password"> | null = null;

  private async ensureAttached(chromeId: number, projectTabId: string): Promise<void> {
    const state = this.sessionState.get(chromeId);
    if (state === "RETIRING") {
      // A retirement is in flight: reattachment is blocked until it settles
      // so a stale detach can never tear down the new attachment. Serialize
      // behind the retirement rather than racing it.
      await this.retireWaiters.get(chromeId);
      return this.ensureAttached(chromeId, projectTabId);
    }
    if (state === "UNCERTAIN") {
      throw new SnapshotError(
        "DEBUGGER_UNAVAILABLE",
        `tab ${JSON.stringify(projectTabId)} debugger session is uncertain after a retirement failure`,
      );
    }
    // Opportunistic hygiene: starting work on this tab reaps other tabs
    // whose debugger has idled out (drops their infobar + CDP exposure).
    // This tab is excluded; its own activity is stamped by the sends below.
    await this.detachIdleTabs(Date.now(), chromeId);
    if (this.owned.has(chromeId)) {
      return;
    }
    try {
      await this.debuggerChrome.attach(chromeId);
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (isExternalDebuggerMessage(message)) {
        // Fixed safe message: the raw attach error may itself echo caller
        // content in adversarial harnesses; never propagate it.
        throw new SnapshotError(
          "DEBUGGER_UNAVAILABLE",
          `tab ${JSON.stringify(projectTabId)} already has a debugger attached`,
        );
      }
      if (isTabGoneMessage(message)) {
        throw new SnapshotError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectTabId)} no longer exists`);
      }
      throw new SnapshotError(
        "SNAPSHOT_FAILED",
        `could not attach the debugger to tab ${JSON.stringify(projectTabId)}: ${message}`,
      );
    }
    this.owned.add(chromeId);
    this.sessionState.set(chromeId, "OWNED");
  }

  /**
   * Raw low-level transport sender. Private by design: every production
   * call site must go through a typed scoped sender above (snapshotSend /
   * interactionSend / evaluateSend / screenshotSend / waitSend /
   * consoleSend / networkSend), which is what makes the operation boundary
   * structural rather than advisory.
   * The global union check below is a defense-in-depth backstop only.
   */
  private async rawSend(chromeId: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.methodAllowed(method)) {
      throw new SnapshotError("SNAPSHOT_FAILED", `refusing non-allowlisted debugger method ${method}`);
    }
    // Every CDP command counts as debugger activity (single funnel for all
    // scoped senders), keeping the idle-detach lifetime honest.
    this.lastCdpActivityMs.set(chromeId, Date.now());
    return this.debuggerChrome.sendCommand(chromeId, method, params);
  }

  /** Backstop union check: never the primary feature boundary. */
  private methodAllowed(method: string): boolean {
    for (const methods of Object.values(CDP_CAPABILITY_METHODS)) {
      if ((methods as readonly string[]).includes(method)) {
        return true;
    }
      }
    return false;
  }

  private async collectAxTree(chromeId: number): Promise<RawAxNode[]> {
    await this.snapshotSend(chromeId, "Accessibility.enable");
    const tree = await this.snapshotSend(chromeId, "Accessibility.getFullAXTree", {});
    const nodes = tree["nodes"];
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new SnapshotError("SNAPSHOT_FAILED", "the page exposed no accessible nodes to snapshot");
    }
    const raw: RawAxNode[] = [];
    for (const node of nodes) {
      if (isRecord(node)) {
        raw.push(node);
      }
    }
    if (raw.length === 0) {
      throw new SnapshotError("SNAPSHOT_FAILED", "the page exposed no accessible nodes to snapshot");
    }
    return raw;
  }

  /**
   * Fail-closed editable-value classification: probe at most
   * MAX_PASSWORD_PROBES value-bearing editable backend ids via
   * DOM.describeNode and positively classify each as "safe" (an input
   * whose type is positively established non-password) or "password".
   * Controls beyond the probe budget, describeNode failures, DOM.enable
   * failures, missing/non-record describe results, unknown editable/input
   * types, and missing backend ids are all absent from the map, and the
   * normalizer redacts every such value. The credential-name heuristic in
   * the normalizer remains a second layer only.
   */
  private async classifyEditableValues(
    chromeId: number,
    axNodes: RawAxNode[],
    capability: "snapshot" | "wait" = "snapshot",
  ): Promise<Map<number, "safe" | "password">> {
    const candidates: number[] = [];
    for (const node of axNodes) {
      const role = typeof node.role === "string"
        ? node.role
        : isRecord(node.role) && typeof node.role["value"] === "string"
          ? (node.role["value"] as string)
          : "";
      const lowered = role.trim().toLowerCase();
      if (lowered !== "textbox" && lowered !== "searchbox" && lowered !== "spinbutton" && lowered !== "combobox") {
        continue;
      }
      if (typeof node.backendDOMNodeId === "number" && Number.isInteger(node.backendDOMNodeId)) {
        candidates.push(node.backendDOMNodeId);
        if (candidates.length >= MAX_PASSWORD_PROBES) {
          break;
        }
      }
    }
    const safety = new Map<number, "safe" | "password">();
    if (candidates.length === 0) {
      return safety;
    }
    let domEnabled = true;
    try {
      await (capability === "wait"
        ? this.waitSend(chromeId, "DOM.enable")
        : this.snapshotSend(chromeId, "DOM.enable"));
    } catch {
      // Fail closed: without DOM.enable no control is positively safe.
      return safety;
    }
    void domEnabled;
    for (const backendNodeId of candidates) {
      try {
        const described = await (capability === "wait"
          ? this.waitSend(chromeId, "DOM.describeNode", { backendNodeId })
          : this.snapshotSend(chromeId, "DOM.describeNode", { backendNodeId }));
        const node = described["node"];
        if (!isRecord(node)) {
          continue;
        }
        const nodeName = typeof node["nodeName"] === "string" ? (node["nodeName"] as string).toLowerCase() : "";
        const attributes = Array.isArray(node["attributes"]) ? (node["attributes"] as unknown[]) : [];
        let typeValue: string | null = null;
        for (let index = 0; index + 1 < attributes.length; index += 2) {
          const name = typeof attributes[index] === "string" ? String(attributes[index]).toLowerCase() : "";
          const value = typeof attributes[index + 1] === "string" ? String(attributes[index + 1]).toLowerCase() : "";
          if (name === "type") {
            typeValue = value;
            break;
          }
        }
        // Only a positively established non-password input type is safe.
        // textarea/select (no type attr) and unknown node shapes stay
        // unclassified -> redacted by the normalizer (fail closed).
        if (nodeName === "input" && typeValue !== null && typeValue !== "") {
          safety.set(backendNodeId, typeValue === "password" ? "password" : "safe");
        }
      } catch {
        // Per-node failure stays unclassified -> redacted (fail closed).
        continue;
      }
    }
    return safety;
  }

  private commandFailure(chromeId: number, projectTabId: string, error: unknown): SnapshotError {
    if (error instanceof SnapshotError) {
      if (error.code === "SNAPSHOT_FAILED" && /no accessible nodes/.test(error.message)) {
        return error;
      }
    }
    const message = errorMessage(error);
    if (isExternalDebuggerMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      const entry = this.entries.get(chromeId);
      entry?.refs.clear();
      return new SnapshotError(
        "DEBUGGER_UNAVAILABLE",
        `tab ${JSON.stringify(projectTabId)} already has a debugger attached: ${message}`,
      );
    }
    if (isTabGoneMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      this.entries.delete(chromeId);
      return new SnapshotError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectTabId)} no longer exists`);
    }
    if (isNotAttachedMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      const entry = this.entries.get(chromeId);
      entry?.refs.clear();
    }
    const code = (error as { code?: unknown }).code;
    if (code === "TAB_NOT_FOUND" || code === "TAB_INVALID_ID") {
      return new SnapshotError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectTabId)} no longer exists`);
    }
    if (code === "TAB_NOT_CONTROLLABLE" || code === "DEBUGGER_UNAVAILABLE") {
      return error as SnapshotError;
    }
    return new SnapshotError(
      "SNAPSHOT_FAILED",
      `could not snapshot tab ${JSON.stringify(projectTabId)}: ${message}`,
    );
  }

  // Page tools. Each is reachable only through its explicit bridge
  // method; there is no generic CDP surface anywhere.

  /** Resolve the selected project tab to (chromeId, record); pre-attach gates. */
  private async resolveSelectedTab(projectTabId: string): Promise<{ chromeId: number; record: SnapshotTabRecord }> {
    let chromeId: number;
    try {
      chromeId = await this.resolveTab(projectTabId);
    } catch (error: unknown) {
      throw this.preserveTabError(error, projectTabId);
    }
    const record = this.getRecord(chromeId);
    if (record === null || !isSnapshotableSourceUrl(record.url)) {
      throw new SnapshotError(
        "TAB_NOT_CONTROLLABLE",
        `tab ${JSON.stringify(projectTabId)} is not a controllable web page`,
      );
    }
    return { chromeId, record };
  }

  /**
   * Evaluate page JavaScript in the selected controllable tab.
   *
   * Fixed Runtime.evaluate call (awaitPromise + returnByValue, no user
   * gesture, no command-line API, native timeout guard); the expression
   * source travels only in the CDP params and never in any error, log, or
   * result metadata. Arbitrary JS may mutate page state, so a dispatched
   * evaluation invalidates the tab's refs even when the page throws.
   * Pre-dispatch validation failures leave refs untouched.
   *
   * Timeout semantics (no rollback claim): the native Runtime.evaluate
   * timeout guards synchronous execution; the local deadline bounds
   * BrowserMcp's await; on an await timeout the owned debugger attachment
   * is retired (never reused, never a foreign detach). Page-side async
   * work already scheduled may continue. No Runtime.terminateExecution.
   */
  async evaluateElement(
    projectTabId: string,
    expression: string,
    timeoutMs?: number,
  ): Promise<{ kind: string; value?: unknown }> {
    if (typeof expression !== "string" || expression.length === 0) {
      throw new SnapshotError("EVALUATION_FAILED", "evaluation requires a non-empty expression");
    }
    if (pageToolsUtf8Length(expression) > EVALUATE_EXPRESSION_LIMIT_BYTES) {
      throw new SnapshotError(
        "EVALUATION_FAILED",
        `expression exceeds the ${String(EVALUATE_EXPRESSION_LIMIT_BYTES)} UTF-8 byte limit`,
      );
    }
    const effectiveTimeoutMs = timeoutMs === undefined ? EVALUATE_DEFAULT_TIMEOUT_MS : timeoutMs;
    if (!Number.isInteger(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
      throw new SnapshotError("EVALUATION_TIMEOUT", "evaluation requires a positive integer timeout");
    }
    if (effectiveTimeoutMs > EVALUATE_MAX_TIMEOUT_MS) {
      throw new SnapshotError("EVALUATION_TIMEOUT", "evaluation timeout exceeds the hard maximum");
    }
    const { chromeId } = await this.resolveSelectedTab(projectTabId);
    await this.ensureAttached(chromeId, projectTabId);
    let evaluated: Record<string, unknown>;
    try {
      evaluated = await this.sendEvaluateWithTimeout(chromeId, {
        expression,
        awaitPromise: true,
        returnByValue: true,
        includeCommandLineAPI: false,
        userGesture: false,
        timeout: effectiveTimeoutMs,
      }, effectiveTimeoutMs);
    } catch (error: unknown) {
      // Dispatch happened (or may have): refs are stale regardless.
      this.invalidateTabByProject(projectTabId);
      throw this.evaluationDispatchFailure(chromeId, projectTabId, error);
    }
    // Dispatched: refs are stale even on the exception path below.
    this.invalidateTabByProject(projectTabId);
    return toProjectEvaluateValue(evaluated);
  }

  private evaluationDispatchFailure(
    chromeId: number,
    projectTabId: string,
    error: unknown,
  ): SnapshotError {
    if (error instanceof SnapshotError && error.code === "EVALUATION_TIMEOUT") {
      return error;
    }
    const message = errorMessage(error);
    if (isExternalDebuggerMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      const entry = this.entries.get(chromeId);
      entry?.refs.clear();
      return new SnapshotError("DEBUGGER_UNAVAILABLE", `tab ${JSON.stringify(projectTabId)} already has a debugger attached`);
    }
    if (isTabGoneMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      this.entries.delete(chromeId);
      return new SnapshotError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectTabId)} no longer exists`);
    }
    if (isNotAttachedMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      const entry = this.entries.get(chromeId);
      entry?.refs.clear();
    }
    return new SnapshotError("EVALUATION_FAILED", "Page evaluation failed.");
  }

  /**
   * Viewport-only PNG screenshot (read-only: never invalidates refs).
   * Fixed Page.captureScreenshot parameters; Page.enable is not used.
   */
  async captureScreenshot(projectTabId: string): Promise<{ mimeType: "image/png"; data: string }> {
    const { chromeId } = await this.resolveSelectedTab(projectTabId);
    await this.ensureAttached(chromeId, projectTabId);
    let shot: Record<string, unknown>;
    try {
      shot = await this.screenshotSend(chromeId, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
    } catch (error: unknown) {
      throw this.screenshotDispatchFailure(chromeId, projectTabId, error);
    }
    const data = shot["data"];
    if (typeof data !== "string" || data.length === 0) {
      throw new SnapshotError("SCREENSHOT_FAILED", "the browser returned an empty screenshot");
    }
    const decoded = safeBase64DecodedLength(data);
    if (decoded === null) {
      throw new SnapshotError("SCREENSHOT_FAILED", "the browser returned an invalid screenshot encoding");
    }
    if (decoded > SCREENSHOT_DECODED_LIMIT_BYTES) {
      throw new SnapshotError(
        "SCREENSHOT_TOO_LARGE",
        `screenshot exceeds the ${String(SCREENSHOT_DECODED_LIMIT_BYTES)} decoded-byte limit`,
      );
    }
    // PNG prefix check: base64 syntax was validated above; decode at most
    // the 8 signature bytes through a safe wrapper (never throws outward,
    // never echoes payload bytes in errors/logs).
    const prefix = safeBase64PrefixBytes(data, PNG_SIGNATURE.length);
    if (prefix === null || !hasPngSignature(prefix)) {
      throw new SnapshotError("SCREENSHOT_FAILED", "the browser returned an invalid PNG signature");
    }
    // Transport fit: the complete encoded bridge frame (base64 + envelope)
    // must stay within the large-response bound. Measure with the real
    // envelope overhead margin, not just the decoded cap.
    const frameBytes = data.length + 512;
    if (frameBytes > LARGE_RESPONSE_FRAME_MAX_BYTES) {
      throw new SnapshotError(
        "SCREENSHOT_TOO_LARGE",
        "screenshot does not fit the bounded transport frame",
      );
    }
    return { mimeType: "image/png", data };
  }

  private screenshotDispatchFailure(chromeId: number, projectTabId: string, error: unknown): SnapshotError {
    const message = errorMessage(error);
    if (isExternalDebuggerMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      const entry = this.entries.get(chromeId);
      entry?.refs.clear();
      return new SnapshotError("DEBUGGER_UNAVAILABLE", `tab ${JSON.stringify(projectTabId)} already has a debugger attached`);
    }
    if (isTabGoneMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      this.entries.delete(chromeId);
      return new SnapshotError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectTabId)} no longer exists`);
    }
    if (isNotAttachedMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      const entry = this.entries.get(chromeId);
      entry?.refs.clear();
    }
    const code = (error as { code?: unknown }).code;
    if (code === "TAB_NOT_FOUND" || code === "TAB_INVALID_ID") {
      return new SnapshotError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectTabId)} no longer exists`);
    }
    return new SnapshotError("SCREENSHOT_FAILED", "could not capture a screenshot of the selected tab");
  }

  /**
   * Evaluate-only bounded send with a caller (local) deadline plus safe
   * owned-session retirement (replaces the old fire-and-forget reset).
   *
   * State machine per chrome tab:
   *   OWNED -> RETIRING (synchronously at local-deadline fire) ->
   *     DETACHED (retirement detach settled) or UNCERTAIN (detach
   *     failed/stalled).
   *
   * Retirement is serialized: ensureAttached blocks (awaits the retirement
   * Promise) instead of racing a new attach against the stale detach, so a
   * late detach for generation A can never tear down generation B.
   *
   * The late-settling sendCommand Promise is always consumed: fulfillment
   * is ignored, rejection is swallowed, and neither may send a second RPC
   * response, mutate a newer session, restore refs, or leak result/source.
   *
   * The retirement detach itself is bounded (retireDetachTimeoutMs); on
   * detach failure/stall the tab is marked UNCERTAIN and future
   * debugger-requiring operations fail DEBUGGER_UNAVAILABLE until
   * lifecycle reconciliation (onDetach/tab removal) proves safety.
   */
  private async sendEvaluateWithTimeout(
    chromeId: number,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pending = this.evaluateSend(chromeId, "Runtime.evaluate", params);
    // The pending CDP command may settle after the public timeout. Consume
    // both outcomes exactly once here so nothing downstream can observe an
    // unhandled rejection or a second response/state mutation.
    pending.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        let settled = false;
        pending.then(
          (result) => {
            if (!settled) {
              settled = true;
              resolve(result);
            }
          },
          (error: unknown) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          },
        );
        timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new SnapshotError("EVALUATION_TIMEOUT", `evaluation timed out after ${String(timeoutMs)}ms`));
          }
        }, timeoutMs);
      });
    } catch (error: unknown) {
      if (error instanceof SnapshotError && error.code === "EVALUATION_TIMEOUT") {
        await this.retireOwnedSessionAfterTimeout(chromeId);
      }
      throw error;
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Retire the timed-out owned debugger attachment (no unused parameters:
   * ref invalidation stays caller-owned in evaluateElement).
   *
   * Marks RETIRING synchronously, detaches ONLY positively-owned
   * attachments (never foreign), awaits the bounded detach, then settles
   * to DETACHED or UNCERTAIN. Blocks reattachment until settled.
   */
  private async retireOwnedSessionAfterTimeout(chromeId: number): Promise<void> {
    if (this.sessionState.get(chromeId) === "RETIRING") {
      await this.retireWaiters.get(chromeId);
      return;
    }
    if (!this.owned.has(chromeId)) {
      // Foreign or already-gone debugger: nothing to retire, never detach.
      return;
    }
    this.sessionState.set(chromeId, "RETIRING");
    let resolveRetirement: () => void = () => undefined;
    const retirement = new Promise<void>((resolve) => {
      resolveRetirement = resolve;
    });
    this.retireWaiters.set(chromeId, retirement);
    try {
      await this.detachWithTimeout(chromeId, this.retireDetachTimeoutMs);
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
    } catch {
      // Detach failed/stalled: ownership is uncertain. Drop local reuse but
      // mark UNCERTAIN so future debugger operations fail closed instead of
      // racing a blind reattach. Never detach again blindly.
      this.owned.delete(chromeId);
      this.sessionState.set(chromeId, "UNCERTAIN");
    } finally {
      this.retireWaiters.delete(chromeId);
      resolveRetirement();
    }
  }

  /** Bounded detach: rejects when the detach does not settle in time. */
  private async detachWithTimeout(chromeId: number, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        void this.debuggerChrome.detach(chromeId).then(
          () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          (error: unknown) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          },
        );
        timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new SnapshotError("DEBUGGER_UNAVAILABLE", "debugger retirement detach timed out"));
          }
        }, timeoutMs);
      });
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Read-only semantic text corpus for wait-for-text polling.
   *
   * Dedicated Accessibility inspection that never allocates refs and never
   * touches the latest-snapshot ref table. Applies the same fail-closed
   * value-safety model as snapshots: password/protected/uncertain editable
   * values never enter the corpus, so wait_for(text) cannot confirm a
   * secret that snapshot/getText would redact.
   */
  async waitTextCorpus(projectTabId: string): Promise<string> {
    const { chromeId } = await this.resolveSelectedTab(projectTabId);
    await this.ensureAttached(chromeId, projectTabId);
    let axNodes: RawAxNode[];
    try {
      axNodes = await this.collectWaitAxTree(chromeId);
    } catch (error: unknown) {
      throw this.waitDispatchFailure(chromeId, projectTabId, error);
    }
    let valueSafety: Map<number, "safe" | "password">;
    try {
      valueSafety = await this.classifyEditableValues(chromeId, axNodes, "wait");
    } catch {
      valueSafety = new Map();
    }
    const parts: string[] = [];
    for (const node of axNodes) {
      const part = waitCorpusTextForNode(node, valueSafety);
      if (part !== "") {
        parts.push(part);
      }
    }
    return parts.join("\n");
  }

  /** Full-tree read for wait polling; no refs, no snapshotId, no table writes. */
  private async collectWaitAxTree(chromeId: number): Promise<RawAxNode[]> {
    await this.waitSend(chromeId, "Accessibility.enable");
    const tree = await this.waitSend(chromeId, "Accessibility.getFullAXTree", {});
    const nodes = tree["nodes"];
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new SnapshotError("SNAPSHOT_FAILED", "the page exposed no accessible nodes");
    }
    const raw: RawAxNode[] = [];
    for (const node of nodes) {
      if (isRecord(node)) {
        raw.push(node);
      }
    }
    if (raw.length === 0) {
      throw new SnapshotError("SNAPSHOT_FAILED", "the page exposed no accessible nodes");
    }
    return raw;
  }

  private waitDispatchFailure(chromeId: number, projectTabId: string, error: unknown): SnapshotError {
    if (error instanceof SnapshotError) {
      return error;
    }
    const message = errorMessage(error);
    if (isExternalDebuggerMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      const entry = this.entries.get(chromeId);
      entry?.refs.clear();
      return new SnapshotError("DEBUGGER_UNAVAILABLE", `tab ${JSON.stringify(projectTabId)} already has a debugger attached`);
    }
    if (isTabGoneMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      this.entries.delete(chromeId);
      return new SnapshotError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectTabId)} no longer exists`);
    }
    if (isNotAttachedMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      const entry = this.entries.get(chromeId);
      entry?.refs.clear();
    }
    return new SnapshotError("SNAPSHOT_FAILED", "the page exposed no accessible text to wait on");
  }

  /**
   * One atomic read-only wait poll against browser truth.
   *
   * Node owns the deadline loop and selection-stability checks; the
   * extension answers a single poll with no sleep, no JS, no snapshotId,
   * no ref allocation, and no ref-table writes. Every branch resolves the
   * selected project tab through the owned debugger manager (never steals
   * a foreign session) or through the injected tab record reader.
   *
   * Payload shape (all caller strings length-gated by Node; re-checked
   * here before use):
   * - { type: "load" } — tab loading status complete.
   * - { type: "url", match, value } — authoritative tab URL equals/contains.
   * - { type: "title", match, value } — authoritative tab title equals/contains.
   * - { type: "text", value } — waitTextCorpus contains.
   */
  async waitCheck(
    projectTabId: string,
    payload: Record<string, unknown>,
  ): Promise<{ matched: boolean; observed: string }> {
    const type = payload["type"];
    if (type !== "load" && type !== "url" && type !== "title" && type !== "text") {
      throw new SnapshotError("SNAPSHOT_FAILED", "wait.check requires a supported condition type");
    }
    if (type === "load") {
      const record = await this.waitTabRecord(projectTabId);
      return { matched: record.status === "complete", observed: record.status };
    }
    const value = payload["value"];
    if (typeof value !== "string" || value.length === 0) {
      throw new SnapshotError("SNAPSHOT_FAILED", "wait.check requires a non-empty condition value");
    }
    if (pageToolsUtf8Length(value) > WAIT_CONDITION_LIMIT_BYTES) {
      throw new SnapshotError("SNAPSHOT_FAILED", "wait.check condition value exceeds the byte limit");
    }
    if (type === "url" || type === "title") {
      const match = payload["match"];
      if (match !== "equals" && match !== "contains") {
        throw new SnapshotError("SNAPSHOT_FAILED", "wait.check requires match equals|contains");
      }
      const record = await this.waitTabRecord(projectTabId);
      const observed = type === "url" ? record.url : record.title;
      const matched = match === "equals" ? observed === value : observed.includes(value);
      return { matched, observed: observed.slice(0, 500) };
    }
    const corpus = await this.waitTextCorpus(projectTabId);
    return { matched: corpus.includes(value), observed: "" };
  }

  /**
   * Authoritative tab metadata for load/url/title polls. Resolution goes
   * through the project TabId (fail closed on stale/foreign ids) and the
   * controllability gate runs before anything else: a privileged redirect
   * fails TAB_NOT_CONTROLLABLE even for a metadata-only poll.
   */
  private async waitTabRecord(projectTabId: string): Promise<{ url: string; title: string; status: string }> {
    let chromeId: number;
    try {
      chromeId = await this.resolveTab(projectTabId);
    } catch (error: unknown) {
      throw this.preserveTabError(error, projectTabId);
    }
    const record = this.getRecord(chromeId);
    if (record === null || !isSnapshotableSourceUrl(record.url)) {
      throw new SnapshotError(
        "TAB_NOT_CONTROLLABLE",
        `tab ${JSON.stringify(projectTabId)} is not a controllable web page`,
      );
    }
    return { url: record.url, title: record.title, status: this.tabStatus(chromeId) };
  }

  // Console/network observability. Same manager, same ownership model,
  // same RETIRING/UNCERTAIN discipline as every other debugger path above:
  // get ensures monitoring (attach + domain enable) for the selected
  // controllable tab; clear empties that tab's buffer without touching the
  // page, refs, or any foreign debugger. Raw debugger events never cross
  // the bridge; only sanitized, redacted, bounded project-owned entries do.

  /** Per-tab observability state (in-memory; worker restart resets). */
  private readonly observability = new Map<
    number,
    {
      projectId: string;
      consoleEntries: ConsoleEntry[];
      consoleDropped: number;
      consoleEnabled: boolean;
      networkEntries: NetworkEntry[];
      networkDropped: number;
      networkEnabled: boolean;
      pendingRequests: Map<string, NetworkEntry>;
      observationCounter: number;
    }
  >();

  private observabilityConsoleCapacity = CONSOLE_BUFFER_DEFAULT_ENTRIES;
  private observabilityNetworkCapacity = NETWORK_BUFFER_DEFAULT_ENTRIES;

  /** Test hook: override buffer capacities (clamped to hard maxima). */
  setObservabilityCapacitiesForTests(consoleEntries?: number, networkEntries?: number): void {
    this.observabilityConsoleCapacity = clampBufferCapacity(
      consoleEntries,
      CONSOLE_BUFFER_DEFAULT_ENTRIES,
      CONSOLE_BUFFER_HARD_MAX_ENTRIES,
    );
    this.observabilityNetworkCapacity = clampBufferCapacity(
      networkEntries,
      NETWORK_BUFFER_DEFAULT_ENTRIES,
      NETWORK_BUFFER_HARD_MAX_ENTRIES,
    );
  }

  /** Active project tab for a chrome id (observability buffer key guard). */
  private observabilityEntryFor(chromeId: number, projectTabId: string): {
    projectId: string;
    consoleEntries: ConsoleEntry[];
    consoleDropped: number;
    consoleEnabled: boolean;
    networkEntries: NetworkEntry[];
    networkDropped: number;
    networkEnabled: boolean;
    pendingRequests: Map<string, NetworkEntry>;
    observationCounter: number;
  } {
    const existing = this.observability.get(chromeId);
    if (existing !== undefined && existing.projectId === projectTabId) {
      return existing;
    }
    // Stale project identity (tab replaced/reused): fail closed to a fresh
    // empty state rather than serving another tab's observations.
    const fresh = {
      projectId: projectTabId,
      consoleEntries: [] as ConsoleEntry[],
      consoleDropped: 0,
      consoleEnabled: false,
      networkEntries: [] as NetworkEntry[],
      networkDropped: 0,
      networkEnabled: false,
      pendingRequests: new Map<string, NetworkEntry>(),
      observationCounter: 0,
    };
    this.observability.set(chromeId, fresh);
    return fresh;
  }

  private clearObservabilityDomains(chromeId: number): void {
    const state = this.observability.get(chromeId);
    if (state !== undefined) {
      state.consoleEnabled = false;
      state.networkEnabled = false;
    }
  }

  private clearAllObservabilityDomains(): void {
    for (const state of this.observability.values()) {
      state.consoleEnabled = false;
      state.networkEnabled = false;
    }
  }

  private clearObservabilityForChrome(chromeId: number): void {
    this.observability.delete(chromeId);
  }

  /** Worker-instance reset for tests: empty buffers, defaults kept. */
  resetObservabilityForTests(): void {
    this.observability.clear();
  }

  /** Domain-enabled state for tests/diagnostics (never public). */
  observabilityDomainsForTests(chromeId: number): { consoleEnabled: boolean; networkEnabled: boolean } | null {
    const state = this.observability.get(chromeId);
    return state === undefined ? null : { consoleEnabled: state.consoleEnabled, networkEnabled: state.networkEnabled };
  }

  /** Route one chrome.debugger.onEvent delivery to the monitors. */
  handleDebuggerEvent(chromeId: number | undefined, method: string, params: Record<string, unknown> | undefined): void {
    if (chromeId === undefined) {
      return;
    }
    // During RETIRING/UNCERTAIN the attachment is not the current session:
    // never treat incoming events as valid observations.
    const ownership = this.sessionState.get(chromeId);
    if (ownership === "RETIRING" || ownership === "UNCERTAIN") {
      return;
    }
    if (!this.owned.has(chromeId)) {
      return;
    }
    const state = this.observability.get(chromeId);
    if (state === undefined) {
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      if (!state.consoleEnabled) {
        return;
      }
      const entry = normalizeConsoleAPICalled(params ?? {}, new Date().toISOString());
      state.consoleEntries.push(entry);
      while (state.consoleEntries.length > this.observabilityConsoleCapacity) {
        state.consoleEntries.shift();
        state.consoleDropped += 1;
      }
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      if (!state.consoleEnabled) {
        return;
      }
      const entry = normalizeExceptionThrown(params ?? {}, new Date().toISOString());
      state.consoleEntries.push(entry);
      while (state.consoleEntries.length > this.observabilityConsoleCapacity) {
        state.consoleEntries.shift();
        state.consoleDropped += 1;
      }
      return;
    }
    if (method === "Network.requestWillBeSent") {
      if (!state.networkEnabled) {
        return;
      }
      this.ingestNetworkRequest(state, params ?? {}, new Date().toISOString());
      return;
    }
    if (method === "Network.responseReceived") {
      if (!state.networkEnabled) {
        return;
      }
      this.ingestNetworkResponse(state, params ?? {});
      return;
    }
    if (method === "Network.loadingFinished") {
      if (!state.networkEnabled) {
        return;
      }
      this.ingestNetworkFinished(state, params ?? {});
      return;
    }
    if (method === "Network.loadingFailed") {
      if (!state.networkEnabled) {
        return;
      }
      this.ingestNetworkFailed(state, params ?? {});
      return;
    }
    // Unsupported debugger events are ignored (never forwarded, never stored).
  }

  private ingestNetworkRequest(
    state: {
      networkEntries: NetworkEntry[];
      networkDropped: number;
      pendingRequests: Map<string, NetworkEntry>;
      observationCounter: number;
    },
    params: Record<string, unknown>,
    startedAt: string,
  ): void {
    const rawRequestId = typeof params["requestId"] === "string" ? (params["requestId"] as string) : "";
    if (rawRequestId === "") {
      return;
    }
    const request = isRecord(params["request"]) ? (params["request"] as Record<string, unknown>) : {};
    const rawUrl = typeof request["url"] === "string" ? (request["url"] as string) : "";
    const entry: NetworkEntry = {
      id: `n-${(state.observationCounter + 1).toString(36)}`,
      startedAt: typeof startedAt === "string" ? startedAt.slice(0, 64) : "",
      method: typeof request["method"] === "string" && (request["method"] as string) !== ""
        ? (request["method"] as string).toUpperCase().slice(0, 16)
        : "GET",
      url: sanitizeUrl(rawUrl, 2048),
      requestHeaders: projectHeaders(request["headers"]),
      hasPostData: request["hasPostData"] === true ||
        (typeof request["postData"] === "string" && (request["postData"] as string) !== ""),
    };
    const resourceType = params["type"];
    if (typeof resourceType === "string" && resourceType !== "") {
      (entry as { resourceType?: string }).resourceType = resourceType.slice(0, 64);
    }
    // Post bodies are NEVER collected: hasPostData is the only signal.
    state.observationCounter += 1;
    const existing = state.pendingRequests.get(rawRequestId);
    if (existing !== undefined) {
      // Redirect: same raw requestId continues; update the single entry.
      const merged: NetworkEntry = { ...existing, method: entry.method, url: entry.url, requestHeaders: entry.requestHeaders, hasPostData: entry.hasPostData };
      if (entry.resourceType !== undefined) {
        (merged as { resourceType?: string }).resourceType = entry.resourceType;
      }
      state.pendingRequests.set(rawRequestId, merged);
      return;
    }
    if (state.pendingRequests.size >= NETWORK_CORRELATION_HARD_MAX) {
      const oldest = state.pendingRequests.keys().next();
      if (!oldest.done) {
        state.pendingRequests.delete(oldest.value);
        state.networkDropped += 1;
      }
    }
    state.pendingRequests.set(rawRequestId, entry);
  }

  private ingestNetworkResponse(
    state: { pendingRequests: Map<string, NetworkEntry> },
    params: Record<string, unknown>,
  ): void {
    const rawRequestId = typeof params["requestId"] === "string" ? (params["requestId"] as string) : "";
    if (rawRequestId === "") {
      return;
    }
    const pending = state.pendingRequests.get(rawRequestId);
    if (pending === undefined) {
      return;
    }
    const response = isRecord(params["response"]) ? (params["response"] as Record<string, unknown>) : {};
    const merged: NetworkEntry = { ...pending };
    if (typeof response["status"] === "number" && Number.isInteger(response["status"])) {
      (merged as { status?: number }).status = response["status"] as number;
    }
    if (typeof response["statusText"] === "string") {
      (merged as { statusText?: string }).statusText = (response["statusText"] as string).slice(0, 128);
    }
    (merged as { responseHeaders?: Record<string, string> }).responseHeaders = projectHeaders(response["headers"]);
    if (typeof response["mimeType"] === "string") {
      (merged as { mimeType?: string }).mimeType = (response["mimeType"] as string).slice(0, 128);
    }
    if (typeof response["protocol"] === "string") {
      (merged as { protocol?: string }).protocol = (response["protocol"] as string).slice(0, 64);
    }
    if (typeof response["fromDiskCache"] === "boolean") {
      (merged as { fromDiskCache?: boolean }).fromDiskCache = response["fromDiskCache"] as boolean;
    }
    state.pendingRequests.set(rawRequestId, merged);
  }

  private ingestNetworkFinished(
    state: { pendingRequests: Map<string, NetworkEntry>; networkEntries: NetworkEntry[]; networkDropped: number },
    params: Record<string, unknown>,
  ): void {
    const rawRequestId = typeof params["requestId"] === "string" ? (params["requestId"] as string) : "";
    if (rawRequestId === "") {
      return;
    }
    const pending = state.pendingRequests.get(rawRequestId);
    if (pending === undefined) {
      return;
    }
    state.pendingRequests.delete(rawRequestId);
    this.pushNetworkFinished(state, pending);
  }

  private ingestNetworkFailed(
    state: { pendingRequests: Map<string, NetworkEntry>; networkEntries: NetworkEntry[]; networkDropped: number },
    params: Record<string, unknown>,
  ): void {
    const rawRequestId = typeof params["requestId"] === "string" ? (params["requestId"] as string) : "";
    if (rawRequestId === "") {
      return;
    }
    const pending = state.pendingRequests.get(rawRequestId);
    if (pending === undefined) {
      return;
    }
    state.pendingRequests.delete(rawRequestId);
    const merged: NetworkEntry = { ...pending, failed: true };
    if (typeof params["errorText"] === "string") {
      (merged as { errorText?: string }).errorText = (params["errorText"] as string).slice(0, 256);
    }
    this.pushNetworkFinished(state, merged);
  }

  private pushNetworkFinished(
    state: { networkEntries: NetworkEntry[]; networkDropped: number },
    entry: NetworkEntry,
  ): void {
    if (state.networkEntries.length >= this.observabilityNetworkCapacity) {
      state.networkEntries.shift();
      state.networkDropped += 1;
    }
    state.networkEntries.push(entry);
  }

  /**
   * Ensure console monitoring for the selected controllable tab.
   * Attaches through the normal manager (never steals), enables
   * Runtime.enable once per attachment, applies the requested capacity
   * (clamped to the hard max), and returns the public state. Read-only for
   * the page: never mutates, never allocates snapshot refs.
   */
  async ensureConsoleMonitoring(
    projectTabId: string,
    requestedCapacity?: number,
  ): Promise<{ chromeId: number; projectId: string; capacity: number; monitoring: boolean }> {
    const { chromeId } = await this.resolveSelectedTab(projectTabId);
    await this.ensureAttached(chromeId, projectTabId);
    const state = this.observabilityEntryFor(chromeId, projectTabId);
    if (requestedCapacity !== undefined) {
      const clamped = clampBufferCapacity(requestedCapacity, CONSOLE_BUFFER_DEFAULT_ENTRIES, CONSOLE_BUFFER_HARD_MAX_ENTRIES);
      if (clamped !== this.observabilityConsoleCapacity) {
        // Capacity changes apply to new ingestion; existing entries are kept
        // unless they exceed the new capacity.
        this.observabilityConsoleCapacity = clamped;
        while (state.consoleEntries.length > this.observabilityConsoleCapacity) {
          state.consoleEntries.shift();
          state.consoleDropped += 1;
        }
      }
    }
    if (!state.consoleEnabled) {
      try {
        await this.consoleSend(chromeId, "Runtime.enable");
      } catch (error: unknown) {
        throw this.observabilityDispatchFailure(chromeId, projectTabId, error);
      }
      state.consoleEnabled = true;
    }
    return { chromeId, projectId: projectTabId, capacity: this.observabilityConsoleCapacity, monitoring: true };
  }

  /**
   * Ensure network monitoring for the selected controllable tab.
   * Same ownership discipline as console; enables Network.enable once per
   * attachment. Read-only for the page.
   */
  async ensureNetworkMonitoring(
    projectTabId: string,
    requestedCapacity?: number,
  ): Promise<{ chromeId: number; projectId: string; capacity: number; monitoring: boolean }> {
    const { chromeId } = await this.resolveSelectedTab(projectTabId);
    await this.ensureAttached(chromeId, projectTabId);
    const state = this.observabilityEntryFor(chromeId, projectTabId);
    if (requestedCapacity !== undefined) {
      const clamped = clampBufferCapacity(requestedCapacity, NETWORK_BUFFER_DEFAULT_ENTRIES, NETWORK_BUFFER_HARD_MAX_ENTRIES);
      if (clamped !== this.observabilityNetworkCapacity) {
        this.observabilityNetworkCapacity = clamped;
        while (state.networkEntries.length > this.observabilityNetworkCapacity) {
          state.networkEntries.shift();
          state.networkDropped += 1;
        }
      }
    }
    if (!state.networkEnabled) {
      try {
        await this.networkSend(chromeId, "Network.enable");
      } catch (error: unknown) {
        throw this.observabilityDispatchFailure(chromeId, projectTabId, error);
      }
      state.networkEnabled = true;
    }
    return { chromeId, projectId: projectTabId, capacity: this.observabilityNetworkCapacity, monitoring: true };
  }

  /** Public console get: newest `limit` entries under the response budget. */
  async getConsole(
    projectTabId: string,
    limit?: number,
    requestedCapacity?: number,
  ): Promise<{
    tabId: string;
    monitoring: boolean;
    capacity: number;
    availableEntries: number;
    returnedEntries: number;
    droppedCount: number;
    truncated: boolean;
    entries: ConsoleEntry[];
  }> {
    const ensured = await this.ensureConsoleMonitoring(projectTabId, requestedCapacity);
    const state = this.observabilityEntryFor(ensured.chromeId, projectTabId);
    const safeLimit = normalizeObservabilityLimit(limit);
    const availableEntries = state.consoleEntries.length;
    const requested = availableEntries <= safeLimit
      ? [...state.consoleEntries]
      : state.consoleEntries.slice(availableEntries - safeLimit);
    const measured = (candidate: readonly ConsoleEntry[]): number =>
      observabilityUtf8Length(
        JSON.stringify({
          tabId: projectTabId,
          monitoring: true,
          capacity: ensured.capacity,
          availableEntries,
          returnedEntries: candidate.length,
          droppedCount: state.consoleDropped,
          truncated: false,
          entries: candidate,
        }),
      );
    let fitted: ConsoleEntry[] = requested;
    let truncated = false;
    if (measured(fitted) > OBSERVABILITY_MAX_SERIALIZED_BYTES) {
      truncated = true;
      let low = 0;
      let high = fitted.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (measured(fitted.slice(mid)) <= OBSERVABILITY_MAX_SERIALIZED_BYTES) {
          high = mid;
        } else {
          low = mid + 1;
        }
      }
      fitted = fitted.slice(low);
      if (measured(fitted) > OBSERVABILITY_MAX_SERIALIZED_BYTES) {
        fitted = [];
      }
    }
    // Console text was already redacted at ingestion; run
    // the heuristic once more on the way out (bounded, idempotent).
    const entries = fitted.map((entry) => ({
      ...entry,
      text: redactConsoleText(entry.text, 4000),
    }));
    return {
      tabId: projectTabId,
      monitoring: true,
      capacity: ensured.capacity,
      availableEntries,
      returnedEntries: entries.length,
      droppedCount: state.consoleDropped,
      truncated,
      entries,
    };
  }

  /** Public console clear: empties the buffer, keeps monitoring armed. */
  async clearConsole(projectTabId: string): Promise<{ cleared: true; removedEntries: number; monitoring: boolean }> {
    const { chromeId } = await this.resolveSelectedTab(projectTabId);
    await this.ensureAttached(chromeId, projectTabId);
    const state = this.observabilityEntryFor(chromeId, projectTabId);
    const removed = state.consoleEntries.length;
    state.consoleEntries.length = 0;
    state.consoleDropped = 0;
    return { cleared: true, removedEntries: removed, monitoring: state.consoleEnabled };
  }

  /** Public network get: newest `limit` entries under the response budget. */
  async getNetwork(
    projectTabId: string,
    limit?: number,
    requestedCapacity?: number,
  ): Promise<{
    tabId: string;
    monitoring: boolean;
    capacity: number;
    availableEntries: number;
    returnedEntries: number;
    droppedCount: number;
    truncated: boolean;
    entries: NetworkEntry[];
  }> {
    const ensured = await this.ensureNetworkMonitoring(projectTabId, requestedCapacity);
    const state = this.observabilityEntryFor(ensured.chromeId, projectTabId);
    const safeLimit = normalizeObservabilityLimit(limit);
    const availableEntries = state.networkEntries.length;
    const requested = availableEntries <= safeLimit
      ? [...state.networkEntries]
      : state.networkEntries.slice(availableEntries - safeLimit);
    const measured = (candidate: readonly NetworkEntry[]): number =>
      observabilityUtf8Length(
        JSON.stringify({
          tabId: projectTabId,
          monitoring: true,
          capacity: ensured.capacity,
          availableEntries,
          returnedEntries: candidate.length,
          droppedCount: state.networkDropped,
          truncated: false,
          entries: candidate,
        }),
      );
    let fitted: NetworkEntry[] = requested;
    let truncated = false;
    if (measured(fitted) > OBSERVABILITY_MAX_SERIALIZED_BYTES) {
      truncated = true;
      let low = 0;
      let high = fitted.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (measured(fitted.slice(mid)) <= OBSERVABILITY_MAX_SERIALIZED_BYTES) {
          high = mid;
        } else {
          low = mid + 1;
        }
      }
      fitted = fitted.slice(low);
      if (measured(fitted) > OBSERVABILITY_MAX_SERIALIZED_BYTES) {
        fitted = [];
      }
    }
    return {
      tabId: projectTabId,
      monitoring: true,
      capacity: ensured.capacity,
      availableEntries,
      returnedEntries: fitted.length,
      droppedCount: state.networkDropped,
      truncated,
      entries: fitted.map((entry) => ({ ...entry })),
    };
  }

  /** Public network clear: empties buffer + correlation, keeps armed state. */
  async clearNetwork(projectTabId: string): Promise<{ cleared: true; removedEntries: number; monitoring: boolean }> {
    const { chromeId } = await this.resolveSelectedTab(projectTabId);
    await this.ensureAttached(chromeId, projectTabId);
    const state = this.observabilityEntryFor(chromeId, projectTabId);
    const removed = state.networkEntries.length;
    state.networkEntries.length = 0;
    state.pendingRequests.clear();
    state.networkDropped = 0;
    return { cleared: true, removedEntries: removed, monitoring: state.networkEnabled };
  }

  private observabilityDispatchFailure(chromeId: number, projectTabId: string, error: unknown): SnapshotError {
    const message = errorMessage(error);
    if (isExternalDebuggerMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      this.clearObservabilityDomains(chromeId);
      const entry = this.entries.get(chromeId);
      entry?.refs.clear();
      return new SnapshotError("DEBUGGER_UNAVAILABLE", `tab ${JSON.stringify(projectTabId)} already has a debugger attached`);
    }
    if (isTabGoneMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      this.entries.delete(chromeId);
      this.clearObservabilityForChrome(chromeId);
      return new SnapshotError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectTabId)} no longer exists`);
    }
    if (isNotAttachedMessage(message)) {
      this.owned.delete(chromeId);
      this.sessionState.delete(chromeId);
      this.clearObservabilityDomains(chromeId);
      const entry = this.entries.get(chromeId);
      entry?.refs.clear();
    }
    const code = (error as { code?: unknown }).code;
    if (code === "TAB_NOT_FOUND" || code === "TAB_INVALID_ID") {
      return new SnapshotError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectTabId)} no longer exists`);
    }
    // Fixed safe message: raw params/headers/URLs never surface here.
    return new SnapshotError("OBSERVABILITY_FAILED", "could not enable observability monitoring for the selected tab");
  }
}

/** Get-limit normalization shared by console/network (default 100, max 500). */
function normalizeObservabilityLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return 100;
  }
  return Math.min(raw, OBSERVABILITY_MAX_RETRIEVAL_LIMIT);
}

/** In-memory snapshot session storage (tests / fallback). */
export function createMemorySnapshotSessionStorage(): SnapshotSessionStorage {
  let sessionId: string | null = null;
  let counter = 0;
  return {
    loadSnapshotSession: () => Promise.resolve({ sessionId, counter }),
    saveSnapshotSession: (nextId: string, nextCounter: number) => {
      sessionId = nextId;
      counter = nextCounter;
      return Promise.resolve();
    },
  };
}

export interface SnapshotSessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const SNAPSHOT_SESSION_KEY = "arcMcpSnapshotSession";
const SNAPSHOT_COUNTER_KEY = "arcMcpSnapshotCounter";

/** chrome.storage.session-backed snapshot session (suspension-safe). */
export function createSessionSnapshotStorage(area: SnapshotSessionStorageArea): SnapshotSessionStorage {
  return {
    loadSnapshotSession: async () => {
      const sessionStored = await area.get(SNAPSHOT_SESSION_KEY);
      const counterStored = await area.get(SNAPSHOT_COUNTER_KEY);
      const sessionValue = sessionStored[SNAPSHOT_SESSION_KEY];
      const counterValue = counterStored[SNAPSHOT_COUNTER_KEY];
      return {
        sessionId:
          typeof sessionValue === "string" && isValidSnapshotSessionId(sessionValue) ? sessionValue : null,
        counter: typeof counterValue === "number" && Number.isInteger(counterValue) && counterValue >= 0
          ? counterValue
          : 0,
      };
    },
    saveSnapshotSession: (sessionId: string, counter: number) =>
      area.set({ [SNAPSHOT_SESSION_KEY]: sessionId, [SNAPSHOT_COUNTER_KEY]: counter }).then(() => undefined),
  };
}

/**
 * Project-owned by-value projection of a Runtime.evaluate response.
 *
 * Consumes the fixed call's raw result ({ result: { type, value,
 * unserializableValue, ... }, exceptionDetails? }) and returns only the
 * public envelope { kind, value? }. Page-thrown exceptions become
 * EVALUATION_FAILED with a fixed safe message: raw exception.description /
 * value / stackTrace are never surfaced (they may carry page secrets).
 * Remote object handles (objectId despite returnByValue) are treated as
 * unsupported, never exposed.
 */
export function toProjectEvaluateValue(evaluated: Record<string, unknown>): { kind: string; value?: unknown } {
  if (isRecord(evaluated["exceptionDetails"])) {
    throw new SnapshotError("EVALUATION_FAILED", "Page evaluation failed.");
  }
  const remote = evaluated["result"];
  if (!isRecord(remote)) {
    throw new SnapshotError("EVALUATION_FAILED", "Page evaluation failed.");
  }
  if (typeof remote["objectId"] === "string" || typeof remote["executionContextId"] !== "undefined") {
    throw new SnapshotError("EVALUATION_FAILED", "Page evaluation returned a non-serializable result.");
  }
  const type = typeof remote["type"] === "string" ? (remote["type"] as string) : "";
  if (type === "undefined") {
    return { kind: "undefined" };
  }
  if (typeof remote["unserializableValue"] === "string") {
    return toProjectSpecialValue(remote["unserializableValue"] as string);
  }
  if (type === "bigint") {
    const description = typeof remote["description"] === "string" ? (remote["description"] as string) : "";
    const digits = /^[+-]?[0-9]+$/.test(description.trim()) ? description.trim() : null;
    if (digits === null) {
      throw new SnapshotError("EVALUATION_FAILED", "Page evaluation returned a non-serializable result.");
    }
    return { kind: "bigint", value: digits };
  }
  if (!("value" in remote)) {
    throw new SnapshotError("EVALUATION_FAILED", "Page evaluation failed.");
  }
  const value = remote["value"];
  const projected = projectJsonValue(value);
  const serialized = safeJsonLength(projected);
  if (serialized === null || serialized > EVALUATE_RESULT_MAX_SERIALIZED_BYTES) {
    throw new SnapshotError(
      "EVALUATION_RESULT_TOO_LARGE",
      `evaluation result exceeds the ${String(EVALUATE_RESULT_MAX_SERIALIZED_BYTES)} byte limit`,
    );
  }
  return { kind: "json", value: projected };
}

/** CDP unserializableValue strings for special numeric values. */
function toProjectSpecialValue(unserializable: string): { kind: string } {
  switch (unserializable) {
    case "NaN":
      return { kind: "nan" };
    case "Infinity":
      return { kind: "infinity" };
    case "-Infinity":
      return { kind: "neg-infinity" };
    case "-0":
      return { kind: "neg-zero" };
    default:
      throw new SnapshotError("EVALUATION_FAILED", "Page evaluation returned a non-serializable result.");
  }
}

/**
 * Deep-project a by-value JSON candidate: only plain JSON shapes pass.
 * Functions, symbols, class instances, and cyclic graphs fail closed.
 */
function projectJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 64) {
    throw new SnapshotError(
      "EVALUATION_RESULT_TOO_LARGE",
      `evaluation result exceeds the ${String(EVALUATE_RESULT_MAX_SERIALIZED_BYTES)} byte limit`,
    );
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SnapshotError("EVALUATION_FAILED", "Page evaluation returned a non-serializable result.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => projectJsonValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new SnapshotError("EVALUATION_FAILED", "Page evaluation returned a non-serializable result.");
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = projectJsonValue(entry, depth + 1);
    }
    return out;
  }
  throw new SnapshotError("EVALUATION_FAILED", "Page evaluation returned a non-serializable result.");
}

/** JSON length probe that fails closed on cyclic/unstringifiable shapes. */
function safeJsonLength(value: unknown): number | null {
  try {
    return pageToolsUtf8Length(JSON.stringify(value) ?? "");
  } catch {
    return null;
  }
}

/** Decoded byte length of a base64 string without allocating blindly. */
function safeBase64DecodedLength(data: string): number | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0 || data.length === 0) {
    return null;
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length / 4) * 3) - padding;
}

/**
 * Decode the first `byteCount` bytes of a validated base64 payload without
 * throwing outward and without echoing payload bytes. Returns null on any
 * decode anomaly (fail closed to SCREENSHOT_FAILED at the call site).
 */
function safeBase64PrefixBytes(data: string, byteCount: number): number[] | null {
  try {
    const chars = Math.ceil(byteCount / 3) * 4;
    const decoded = atob(data.slice(0, chars));
    if (decoded.length < byteCount) {
      return null;
    }
    const out: number[] = [];
    for (let index = 0; index < byteCount; index += 1) {
      out.push(decoded.charCodeAt(index) & 0xff);
    }
    return out;
  } catch {
    return null;
  }
}

/** True when the decoded PNG begins with the 8-byte PNG signature. */
export function hasPngSignature(decoded: Uint8Array | number[]): boolean {
  if (decoded.length < PNG_SIGNATURE.length) {
    return false;
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (decoded[index] !== PNG_SIGNATURE[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Wait corpus text for one AX node under the fail-closed value model.
 * Editable values enter the corpus ONLY when positively classified safe
 * (same valueSafety map snapshots use); password/unknown/unprobed values
 * contribute their accessible NAME at most, never the secret-bearing value.
 * Node names of password-like fields keep their label text; only values
 * are withheld.
 */
function waitCorpusTextForNode(node: RawAxNode, valueSafety: ReadonlyMap<number, "safe" | "password">): string {
  const role = typeof node.role === "string"
    ? node.role
    : isRecord(node.role) && typeof node.role["value"] === "string"
      ? (node.role["value"] as string)
      : "";
  const lowered = role.trim().toLowerCase();
  const readField = (field: unknown): string => {
    if (typeof field === "string") {
      return field.trim();
    }
    if (isRecord(field) && typeof field["value"] === "string") {
      return (field["value"] as string).trim();
    }
    return "";
  };
  const name = readField(node.name);
  const value = readField(node.value);
  const description = readField(node.description);
  void WAIT_CONDITION_LIMIT_BYTES;
  if (lowered === "textbox" || lowered === "searchbox" || lowered === "spinbutton" || lowered === "combobox") {
    const backendId = typeof node.backendDOMNodeId === "number" && Number.isInteger(node.backendDOMNodeId)
      ? (node.backendDOMNodeId as number)
      : null;
    if (backendId !== null && valueSafety.get(backendId) === "safe") {
      return [name, value].filter((part) => part !== "").join(" ").trim();
    }
    return name;
  }
  return [name, value, description].filter((part) => part !== "").join(" ").trim();
}
