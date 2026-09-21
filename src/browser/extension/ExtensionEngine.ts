import { BridgeError } from "../../bridge/BridgeError.js";
import { BRIDGE_PROTOCOL_VERSION } from "../../bridge/protocol.js";
import { checkBridgePrerequisites } from "../../bridge/preflight.js";
import type { PrerequisiteIssue } from "../../bridge/preflight.js";
import type { BrowserSpec } from "../chromium/spec.js";
import {
  browserDebuggerUnavailable,
  browserElementNotEditable,
  browserElementNotInteractable,
  browserEvaluationFailed,
  browserEvaluationResultTooLarge,
  browserEvaluationTimeout,
  browserHistoryUnavailable,
  browserInteractionFailed,
  browserInvalidKey,
  browserInvalidText,
  browserNavigationFailed,
  browserNoSelectedTab,
  browserObservabilityConfigInvalid,
  browserObservabilityFailed,
  browserScreenshotFailed,
  browserScreenshotTooLarge,
  browserSnapshotFailed,
  browserStaleElement,
  browserTabCloseFailed,
  browserTabCreateFailed,
  browserTabNotControllable,
  browserTabNotFound,
  browserUrlNotAllowed,
  browserWaitAborted,
  browserWaitTimeout,
} from "../../errors/BrowserError.js";
import { BrowserError } from "../../errors/BrowserError.js";
import { validateNavigationUrl } from "../navigationPolicy.js";
import {
  HUMANIZE_SEQUENCE_DELAY_MAX_MS,
  HUMANIZE_SEQUENCE_DELAY_MIN_MS,
  HUMANIZE_WPM_MAX,
  HUMANIZE_WPM_MIN,
  INTERACTION_TEXT_LIMIT_BYTES,
  PRESS_SEQUENCE_MAX_KEYS,
  normalizeSequenceDelayMs,
  normalizeWpm,
  parsePressKey,
  utf8ByteLength,
} from "../interactionPolicy.js";
import {
  EVALUATE_DEFAULT_TIMEOUT_MS,
  EVALUATE_EXPRESSION_LIMIT_BYTES,
  EVALUATE_MAX_TIMEOUT_MS,
  EVALUATE_RESULT_MAX_SERIALIZED_BYTES,
  PNG_SIGNATURE,
  SCREENSHOT_DECODED_LIMIT_BYTES,
  WAIT_CONDITION_LIMIT_BYTES,
  WAIT_DEFAULT_TIMEOUT_MS,
  WAIT_MAX_TIMEOUT_MS,
  WAIT_MIN_TIMEOUT_MS,
  WAIT_POLL_INTERVAL_MS,
  pageToolsUtf8Length,
} from "../pageToolsPolicy.js";
import {
  CONSOLE_BUFFER_DEFAULT_ENTRIES,
  CONSOLE_BUFFER_HARD_MAX_ENTRIES,
  NETWORK_BUFFER_DEFAULT_ENTRIES,
  NETWORK_BUFFER_HARD_MAX_ENTRIES,
  OBSERVABILITY_MAX_RETRIEVAL_LIMIT,
  OBSERVABILITY_MAX_SERIALIZED_BYTES,
  observabilityUtf8Length,
} from "../../observability/observabilityPolicy.js";
import { redactConsoleText, redactHeaders, sanitizeUrl } from "../../security/Redaction.js";
import { LARGE_RESPONSE_FRAME_MAX_BYTES } from "../../bridge/frameLimits.js";
import { SNAPSHOT_DEFAULT_MAX_NODES, SNAPSHOT_HARD_MAX_NODES, findLeakedCdpKeys, isSnapshotIdSyntax } from "../snapshotSemantics.js";
import type { BrowserEngine } from "../BrowserEngine.js";
import type {
  BrowserStatus,
  BrowserTab,
  ConsoleEntry,
  ConsoleResult,
  ElementRef,
  ElementTextResult,
  EvaluateOptions,
  EvaluateResult,
  EvaluateResultKind,
  NavigateRequest,
  NavigateResult,
  NetworkEntry,
  NetworkResult,
  PressSequenceOptions,
  ScreenshotOptions,
  ScreenshotResult,
  SnapshotNode,
  SnapshotOptions,
  SnapshotResult,
  ClickTypeOptions,
  TabId,
  TypeHumanOptions,
  WaitCondition,
  WaitResult,
} from "../models.js";
import type { BridgeRuntime } from "./BridgeRuntime.js";

export interface ExtensionEngineOptions {
  /** Which browser this engine targets (messaging + scheme policy only). */
  readonly spec: BrowserSpec;
  readonly runtime: BridgeRuntime;
  readonly extensionId: string;
  readonly connectTimeoutMs?: number;
  readonly statusTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly checkPrerequisites?: () => Promise<PrerequisiteIssue[]>;
  /** Buffer capacities (finite; invalid values throw at operation time). */
  readonly consoleBufferEntries?: number;
  readonly networkBufferEntries?: number;
}

export const DEFAULT_EXTENSION_CONNECT_TIMEOUT_MS = 120_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 15_000;
// First verify probe fails fast: a healthy relay answers bridge.status in
// ms, so a full-timeout block means the worker suspended again.
const FIRST_VERIFY_TIMEOUT_MS = 5_000;

/** Schemes that must never be opened/created, for every browser. */
const BASE_BLOCKED_CREATE_SCHEMES = ["javascript:", "data:", "file:", "chrome:", "chrome-extension:", "devtools:", "view-source:"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Decoded byte length of a base64 string; null when malformed. */
function decodedBase64Length(data: string): number | null {
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return null;
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length / 4) * 3) - padding;
}

/** Decode at most the first `bytes` of a base64 payload (signature check). */
function decodeBase64Prefix(data: string, bytes: number): number[] {
  const chars = Math.max(4, Math.ceil(bytes / 3) * 4);
  const prefix = data.slice(0, chars);
  try {
    const raw = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer?.from(prefix, "base64");
    if (raw !== undefined) {
      return [...raw.slice(0, bytes)];
    }
  } catch {
    return [];
  }
  // Extension-safe manual decode fallback (no Node Buffer).
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of prefix) {
    if (char === "=") {
      break;
    }
    const sextet = alphabet.indexOf(char);
    if (sextet < 0) {
      return [];
    }
    buffer = (buffer << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      if (out.length >= bytes) {
        break;
      }
    }
  }
  return out;
}

/** True when the prefix bytes match the PNG file signature. */
function hasPngSignature(prefix: number[]): boolean {
  if (prefix.length < PNG_SIGNATURE.length) {
    return false;
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (prefix[index] !== PNG_SIGNATURE[index]) {
      return false;
    }
  }
  return true;
}

/** Monotonic clock for wait deadlines (never wall-clock arithmetic). */
function nowMs(): number {
  return Date.now();
}

/** Best-effort wall-clock sleep used only between bounded wait polls. */
function delayMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asBrowserTab(value: unknown): BrowserTab {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["title"] !== "string" ||
    typeof value["url"] !== "string" ||
    typeof value["active"] !== "boolean" ||
    typeof value["pinned"] !== "boolean" ||
    typeof value["windowId"] !== "number" ||
    typeof value["controllable"] !== "boolean"
  ) {
    throw new BridgeError("INVALID_ENVELOPE", "malformed tab record from the extension bridge");
  }
  return {
    id: value["id"],
    title: value["title"],
    url: value["url"],
    active: value["active"],
    pinned: value["pinned"],
    windowId: value["windowId"],
    controllable: value["controllable"],
  };
}

/**
 * Primary Windows backend: drives the normal running browser session
 * through the bridge (extension <- native host <- named pipe).
 *
 * Owns only the MCP side (pipe server, session descriptor, engine
 * lifetime). Never launches the browser, the native host, or anything
 * browser-side. Works for any Chromium browser with the bridge extension
 * loaded (Arc, Chrome, ...).
 */
export class ExtensionEngine implements BrowserEngine {
  private state: "disconnected" | "connecting" | "connected" | "error" = "disconnected";
  private lastErrorCode: string | null = null;
  private connectPromise: Promise<void> | null = null;
  private cancelConnect: (() => void) | null = null;
  private shuttingDown = false;
  private unsubscribeRelay: (() => void) | null = null;
  private selectedTabId: TabId | null = null;
  // Successful preflight (manifest + registry) is memoized: neither changes
  // mid-process, so reconnects skip the reg.exe/powershell cold spawns.
  // Failures are never cached — a later bridge:install must be picked up.
  private preflightPassed = false;

  constructor(private readonly options: ExtensionEngineOptions) {}

  private get runtime(): BridgeRuntime {
    return this.options.runtime;
  }

  private connectTimeoutMs(): number {
    return this.options.connectTimeoutMs ?? DEFAULT_EXTENSION_CONNECT_TIMEOUT_MS;
  }

  private statusTimeoutMs(): number {
    return this.options.statusTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  }

  private operationTimeoutMs(): number {
    return this.options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  }

  /** Map a bridge-side navigation failure to the project error taxonomy. */
  private navigationFailure(selectedTabId: TabId, operation: string, error: unknown): BrowserError {
    if (error instanceof BrowserError) {
      return error;
    }
    const remoteCode =
      error instanceof BridgeError && typeof error.details["remoteCode"] === "string"
        ? error.details["remoteCode"]
        : null;
    if (remoteCode === "TAB_NOT_FOUND" || remoteCode === "TAB_INVALID_ID") {
      this.selectedTabId = null;
      return browserTabNotFound(selectedTabId);
    }
    if (remoteCode === "TAB_NOT_CONTROLLABLE") {
      return browserTabNotControllable(selectedTabId, "(privileged source tab)");
    }
    if (remoteCode === "TAB_HISTORY_UNAVAILABLE") {
      const direction = /back/i.test(operation) ? "back" : "forward";
      return browserHistoryUnavailable(direction, selectedTabId);
    }
    if (remoteCode !== null) {
      // Any other typed extension-side code (TAB_NOT_CONTROLLABLE,
      // TAB_URL_NOT_ALLOWED, TAB_NAVIGATION_FAILED, ...) maps to the
      // navigation taxonomy through the operation, never a generic error.
      return browserNavigationFailed(`${operation} rejected by the extension (${remoteCode})`, error);
    }
    return browserNavigationFailed(operation, error);
  }

  /**
   * Extract the post-command tab snapshot. Selection never changes here:
   * the project TabId is stable across navigation, and staleness is
   * reconciled by listTabs/other ops rather than a silent fallback.
   */
  private extractNavigationTab(operation: string, selectedTabId: TabId, record: unknown): BrowserTab {
    if (!isRecord(record) || !isRecord(record["tab"])) {
      throw new BridgeError("INVALID_ENVELOPE", `malformed navigation payload from the extension bridge`);
    }
    const tab = asBrowserTab(record["tab"]);
    if (tab.id !== selectedTabId) {
      throw browserNavigationFailed(`${operation}: bridge returned a different tab than selected`);
    }
    return tab;
  }

  /** Map a bridge-side tab failure to the project error taxonomy. */
  private tabFailure(operation: "select" | "open" | "close" | "list", tabId: string | null, error: unknown): BrowserError {
    if (error instanceof BrowserError) {
      return error;
    }
    const remoteCode =
      error instanceof BridgeError && typeof error.details["remoteCode"] === "string"
        ? error.details["remoteCode"]
        : null;
    if (remoteCode === "TAB_NOT_FOUND" || remoteCode === "TAB_INVALID_ID") {
      return browserTabNotFound(tabId ?? "(unknown)");
    }
    if (operation === "open") {
      return browserTabCreateFailed(error instanceof Error ? error.message : String(error), error);
    }
    if (operation === "close" && tabId !== null) {
      return browserTabCloseFailed(tabId, error);
    }
    return new BrowserError(
      "BROWSER_TAB_NOT_FOUND",
      `Tab operation ${operation} failed: ${error instanceof Error ? error.message : String(error)}.`,
      {},
      { cause: error },
    );
  }

  private observeRelay(): void {
    if (this.unsubscribeRelay !== null) {
      return;
    }
    this.unsubscribeRelay = this.runtime.onRelayChange((connected) => {
      if (this.shuttingDown) {
        return;
      }
      if (connected) {
        if (this.state === "disconnected" || this.state === "error") {
          this.state = "connected";
          this.lastErrorCode = null;
        }
        return;
      }
      if (this.state === "connected") {
        this.state = "disconnected";
        this.lastErrorCode = "BRIDGE_RELAY_LOST";
      }
    });
  }

  async connect(): Promise<void> {
    if (this.state === "connected") {
      return;
    }
    if (this.connectPromise !== null) {
      return this.connectPromise;
    }
    this.shuttingDown = false;
    this.connectPromise = this.connectInner().finally(() => {
      this.connectPromise = null;
      this.cancelConnect = null;
    });
    return this.connectPromise;
  }

  private async connectInner(): Promise<void> {
    this.state = "connecting";
    this.lastErrorCode = null;
    const timeoutMs = (): number => this.connectTimeoutMs();
    try {
      const check = this.options.checkPrerequisites ??
        (() => checkBridgePrerequisites({ expectedOrigin: this.expectedOrigin() }));
      if (!this.preflightPassed) {
        const issues = await check();
        if (issues.length > 0) {
          const first = issues[0];
          throw new BridgeError(
            "BRIDGE_PREFLIGHT_FAILED",
            first === undefined ? "bridge prerequisites failed" : first.remediation,
          );
        }
        this.preflightPassed = true;
      }
      this.observeRelay();
      await this.runtime.start();
      await this.waitForRelay();
      // Transport health verification: the envelope version is validated
      // by the RPC layer and a non-ok answer rejects here. Retried on
      // timeout: relay hosts cycle and a probe lost mid-cycle must not fail
      // connect while a healthy relay is available. No browser behavior is
      // exercised. Retries are bounded to a fraction of the connect timeout
      // so the overall connect() deadline still holds.
      const verifyDeadline = Date.now() + Math.max(this.statusTimeoutMs(), Math.floor(timeoutMs() / 3));
      let verified = false;
      let lastError: unknown = null;
      let verifyAttempts = 0;
      while (!verified && Date.now() < verifyDeadline) {
        try {
          // ponytail: first probe uses a short timeout, retries keep the full one.
          // All probes are clamped to the remaining verify budget so connect()
          // honors its deadline instead of overshooting by a full timeout.
          const baseTimeout =
            verifyAttempts === 0 ? Math.min(this.statusTimeoutMs(), FIRST_VERIFY_TIMEOUT_MS) : this.statusTimeoutMs();
          const probeTimeout = Math.min(baseTimeout, Math.max(verifyDeadline - Date.now(), 0));
          verifyAttempts += 1;
          await this.runtime.request("bridge.status", {}, probeTimeout);
          verified = true;
        } catch (error: unknown) {
          lastError = error;
          if (!(error instanceof BridgeError) || error.code !== "TIMEOUT") {
            throw error;
          }
          if (!this.runtime.isRelayConnected()) {
            await this.waitForRelay();
          }
        }
      }
      if (!verified) {
        throw lastError;
      }
      this.state = "connected";
    } catch (error: unknown) {
      this.lastErrorCode = error instanceof BridgeError ? error.code : "EXTENSION_CONNECT_TIMEOUT";
      this.state = "error";
      await this.runtime.stop().catch(() => undefined);
      throw error;
    }
  }

  private expectedOrigin(): string {
    return `chrome-extension://${this.options.extensionId}/`;
  }

  private waitForRelay(): Promise<void> {
    if (this.shuttingDown) {
      return Promise.reject(new BridgeError("NOT_CONNECTED", "disconnect() called while connecting"));
    }
    if (this.runtime.isRelayConnected()) {
      return Promise.resolve();
    }
    const timeoutMs = this.connectTimeoutMs();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new BridgeError(
            "EXTENSION_CONNECT_TIMEOUT",
            `no authenticated extension relay within ${String(timeoutMs)}ms; is ${this.options.spec.displayName} running with the bridge extension loaded?`,
          ),
        );
      }, timeoutMs);
      const cancel = (): void => {
        cleanup();
        reject(new BridgeError("NOT_CONNECTED", "disconnect() called while connecting"));
      };
      const onChange = (connected: boolean): void => {
        if (connected) {
          cleanup();
          resolve();
        }
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        unsubscribe();
      };
      const unsubscribe = this.runtime.onRelayChange(onChange);
      this.cancelConnect = cancel;
      if (this.runtime.isRelayConnected()) {
        cleanup();
        resolve();
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.state === "disconnected" && this.connectPromise === null) {
      return;
    }
    this.shuttingDown = true;
    this.cancelConnect?.();
    this.cancelConnect = null;
    try {
      await this.connectPromise;
    } catch {
      // Connection attempt already recorded its error state; shutdown wins.
    }
    this.connectPromise = null;
    await this.runtime.stop().catch(() => undefined);
    if (this.unsubscribeRelay !== null) {
      this.unsubscribeRelay();
      this.unsubscribeRelay = null;
    }
    // Explicit teardown ends the selection session; unexpected relay loss
    // instead keeps the ID so reconnect resumes it (next listTabs heals it
    // if the tab actually disappeared).
    this.selectedTabId = null;
    this.state = "disconnected";
  }

  /**
   * Event-driven in-memory state: returns the current engine/transport
   * snapshot without a bridge round trip, so basic status stays fast and
   * bounded even when the relay is down.
   */
  async status(): Promise<BrowserStatus> {
    const live = this.runtime.isRelayConnected();
    const connected = this.state === "connected" && live;
    const state = connected ? "connected" : this.state === "connected" ? "disconnected" : this.state;
    const status: BrowserStatus = {
      connected,
      state,
      backend: "extension",
      profileMode: "normal-running-session",
      selectedTabId: this.selectedTabId,
    };
    if (state === "connecting") {
      return { ...status, reason: "browser-connect-in-progress" };
    }
    if (state === "error") {
      const withReason: BrowserStatus = { ...status, reason: this.lastErrorCode ?? "browser-error" };
      return this.lastErrorCode === null ? withReason : { ...withReason, lastErrorCode: this.lastErrorCode };
    }
    if (!connected) {
      return { ...status, reason: "browser-not-connected" };
    }
    return {
      ...status,
      extensionConnected: true,
      relayConnected: true,
      pipeAuthenticated: true,
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      extensionId: this.options.extensionId,
    };
  }

  async listTabs(): Promise<BrowserTab[]> {
    let payload: unknown;
    try {
      payload = await this.runtime.request("tabs.list", {}, this.operationTimeoutMs());
    } catch (error: unknown) {
      throw this.tabFailure("list", null, error);
    }
    if (!isRecord(payload) || !Array.isArray(payload["tabs"])) {
      throw new BridgeError("INVALID_ENVELOPE", "malformed tabs.list payload from the extension bridge");
    }
    const tabs = payload["tabs"].map((entry) => asBrowserTab(entry));
    if (this.selectedTabId !== null && !tabs.some((tab) => tab.id === this.selectedTabId)) {
      this.selectedTabId = null;
    }
    return tabs;
  }

  async selectTab(tabId: TabId): Promise<void> {
    let record: unknown;
    try {
      record = await this.runtime.request("tabs.activate", { tabId }, this.operationTimeoutMs());
    } catch (error: unknown) {
      throw this.tabFailure("select", tabId, error);
    }
    if (!isRecord(record) || !isRecord(record["tab"])) {
      throw new BridgeError("INVALID_ENVELOPE", "malformed tabs.activate payload from the extension bridge");
    }
    this.selectedTabId = asBrowserTab(record["tab"]).id;
  }

  async openTab(url?: string): Promise<BrowserTab> {
    if (url !== undefined && url.trim() !== "" && url.trim().toLowerCase() !== "about:blank") {
      const normalized = url.trim().toLowerCase();
      if ([...BASE_BLOCKED_CREATE_SCHEMES, ...this.options.spec.blockedCreateSchemes].some((scheme) => normalized.startsWith(scheme))) {
        throw browserTabCreateFailed(`refused dangerous URL scheme in ${JSON.stringify(url)}`);
      }
    }
    let record: unknown;
    try {
      const params: Record<string, unknown> = {};
      if (url !== undefined) {
        params["url"] = url;
      }
      record = await this.runtime.request("tabs.open", params, this.operationTimeoutMs());
    } catch (error: unknown) {
      throw this.tabFailure("open", null, error);
    }
    if (!isRecord(record) || !isRecord(record["tab"])) {
      throw new BridgeError("INVALID_ENVELOPE", "malformed tabs.open payload from the extension bridge");
    }
    const tab = asBrowserTab(record["tab"]);
    this.selectedTabId = tab.id;
    return tab;
  }

  async closeTab(tabId: TabId): Promise<void> {
    try {
      await this.runtime.request("tabs.close", { tabId }, this.operationTimeoutMs());
    } catch (error: unknown) {
      throw this.tabFailure("close", tabId, error);
    }
    if (this.selectedTabId === tabId) {
      this.selectedTabId = null;
    }
  }

  async navigate(request: NavigateRequest): Promise<NavigateResult> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("navigate");
    }
    // Node-side policy first: reject before any bridge traffic.
    const policy = validateNavigationUrl(request.url);
    if (!policy.ok) {
      throw browserUrlNotAllowed(request.url, policy.failure.reason);
    }
    let record: unknown;
    try {
      record = await this.runtime.request(
        "navigation.navigate",
        { tabId: selectedTabId, url: policy.url },
        this.operationTimeoutMs(),
      );
    } catch (error: unknown) {
      throw this.navigationFailure(selectedTabId, "navigate", error);
    }
    const tab = this.extractNavigationTab("navigate", selectedTabId, record);
    return { action: "navigate", accepted: true, requestedUrl: policy.url, tab };
  }

  async goBack(): Promise<void> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("go back");
    }
    try {
      const record = await this.runtime.request(
        "navigation.back",
        { tabId: selectedTabId },
        this.operationTimeoutMs(),
      );
      this.extractNavigationTab("go back", selectedTabId, record);
    } catch (error: unknown) {
      throw this.navigationFailure(selectedTabId, "go back", error);
    }
  }

  async goForward(): Promise<void> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("go forward");
    }
    try {
      const record = await this.runtime.request(
        "navigation.forward",
        { tabId: selectedTabId },
        this.operationTimeoutMs(),
      );
      this.extractNavigationTab("go forward", selectedTabId, record);
    } catch (error: unknown) {
      throw this.navigationFailure(selectedTabId, "go forward", error);
    }
  }

  async reload(ignoreCache?: boolean): Promise<void> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("reload");
    }
    try {
      const record = await this.runtime.request(
        "navigation.reload",
        ignoreCache === true ? { tabId: selectedTabId, ignoreCache: true } : { tabId: selectedTabId },
        this.operationTimeoutMs(),
      );
      this.extractNavigationTab("reload", selectedTabId, record);
    } catch (error: unknown) {
      throw this.navigationFailure(selectedTabId, "reload", error);
    }
  }

  async snapshot(options?: SnapshotOptions): Promise<SnapshotResult> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("capture a snapshot of");
    }
    // Reconcile selection through authoritative tab state first: a closed
    // tab heals to null and fails TAB_NOT_FOUND with no fallback to any
    // other tab. A missing/disappeared tab clears selection the same way.
    let tabs: BrowserTab[];
    try {
      tabs = await this.listTabs();
    } catch (error: unknown) {
      if (error instanceof BrowserError && error.code === "BROWSER_TAB_NOT_FOUND") {
        this.selectedTabId = null;
        throw browserTabNotFound(selectedTabId);
      }
      throw error;
    }
    const selected = tabs.find((tab) => tab.id === selectedTabId);
    if (selected === undefined) {
      this.selectedTabId = null;
      throw browserTabNotFound(selectedTabId);
    }
    // Node-side controllability pre-check (extension revalidates before any
    // debugger attach): only http/https are snapshotable. about:blank is
    // deterministically NOT controllable.
    if (!/^https?:/i.test(selected.url)) {
      throw browserTabNotControllable(selectedTabId, selected.url === "" ? "(empty url)" : selected.url);
    }
    const requestedMax = options?.maxNodes;
    if (requestedMax !== undefined && (!Number.isInteger(requestedMax) || requestedMax <= 0)) {
      throw browserSnapshotFailed(`maxNodes must be a positive integer, got ${String(requestedMax)}`);
    }
    const maxNodes = Math.min(requestedMax ?? SNAPSHOT_DEFAULT_MAX_NODES, SNAPSHOT_HARD_MAX_NODES);
    // Pre-resolve the numeric tab once so tests/fakes that count
    // snapshot.capture traffic exactly see only the capture request: the
    // listTabs() reconcile above already proved the tab exists.
    let payload: unknown;
    try {
      payload = await this.runtime.request(
        "snapshot.capture",
        { tabId: selectedTabId, maxNodes },
        this.snapshotTimeoutMs(),
      );
    } catch (error: unknown) {
      throw this.snapshotFailure(selectedTabId, error);
    }
    const result = this.asSnapshotResult(selectedTabId, payload);
    // Raw CDP ids must never reach MCP output.
    const leaked = findLeakedCdpKeys(result);
    if (leaked.length > 0) {
      throw browserSnapshotFailed(`extension response leaked internal ids (${leaked.join(",")})`);
    }
    if (result.tabId !== selectedTabId) {
      throw browserSnapshotFailed("bridge returned a snapshot for a different tab than selected");
    }
    return result;
  }

  private snapshotTimeoutMs(): number {
    return Math.max(this.operationTimeoutMs(), 30_000);
  }

  /** Map a bridge-side snapshot failure to the project error taxonomy. */
  private snapshotFailure(selectedTabId: TabId, error: unknown): BrowserError {
    if (error instanceof BrowserError) {
      return error;
    }
    const remoteCode =
      error instanceof BridgeError && typeof error.details["remoteCode"] === "string"
        ? error.details["remoteCode"]
        : null;
    if (remoteCode === "TAB_NOT_FOUND" || remoteCode === "TAB_INVALID_ID") {
      this.selectedTabId = null;
      return browserTabNotFound(selectedTabId);
    }
    if (remoteCode === "TAB_NOT_CONTROLLABLE") {
      return browserTabNotControllable(selectedTabId, "(privileged source tab)");
    }
    if (remoteCode === "DEBUGGER_UNAVAILABLE") {
      const message = error instanceof Error ? error.message : String(error);
      return browserDebuggerUnavailable(selectedTabId, message);
    }
    if (remoteCode !== null) {
      return browserSnapshotFailed(`extension rejected the snapshot (${remoteCode})`, error);
    }
    return browserSnapshotFailed("the bridge did not answer the snapshot request", error);
  }

  /** Validate the extension snapshot envelope; unknown shapes fail closed. */
  private asSnapshotResult(_selectedTabId: TabId, payload: unknown): SnapshotResult {
    if (!isRecord(payload)) {
      throw new BridgeError("INVALID_ENVELOPE", "malformed snapshot.capture payload from the extension bridge");
    }
    for (const key of Object.keys(payload)) {
      if (
        key !== "snapshotId" &&
        key !== "tabId" &&
        key !== "url" &&
        key !== "title" &&
        key !== "nodes" &&
        key !== "text" &&
        key !== "truncated" &&
        key !== "totalNodes" &&
        key !== "includedNodes"
      ) {
        throw browserSnapshotFailed(`extension response leaked internal field ${JSON.stringify(key)}`);
      }
    }
    const snapshotId = payload["snapshotId"];
    const tabId = payload["tabId"];
    const url = payload["url"];
    const title = payload["title"];
    const nodes = payload["nodes"];
    const text = payload["text"];
    const truncated = payload["truncated"];
    const totalNodes = payload["totalNodes"];
    const includedNodes = payload["includedNodes"];
    if (
      typeof snapshotId !== "string" ||
      !isSnapshotIdSyntax(snapshotId) ||
      typeof tabId !== "string" ||
      typeof url !== "string" ||
      typeof title !== "string" ||
      !Array.isArray(nodes) ||
      typeof text !== "string" ||
      typeof truncated !== "boolean" ||
      typeof totalNodes !== "number" ||
      typeof includedNodes !== "number"
    ) {
      throw new BridgeError("INVALID_ENVELOPE", "malformed snapshot.capture payload from the extension bridge");
    }
    return {
      snapshotId,
      tabId,
      url,
      title,
      nodes: nodes.map((entry) => this.asSnapshotNode(entry)),
      text,
      truncated,
      totalNodes,
      includedNodes,
    };
  }

  private asSnapshotNode(entry: unknown): SnapshotNode {
    if (!isRecord(entry) || typeof entry["role"] !== "string") {
      throw new BridgeError("INVALID_ENVELOPE", "malformed snapshot node from the extension bridge");
    }
    for (const key of Object.keys(entry)) {
      if (
        key !== "ref" &&
        key !== "role" &&
        key !== "name" &&
        key !== "value" &&
        key !== "description" &&
        key !== "disabled" &&
        key !== "focused" &&
        key !== "selected" &&
        key !== "checked" &&
        key !== "expanded" &&
        key !== "level"
      ) {
        throw browserSnapshotFailed(`extension response leaked internal field ${JSON.stringify(key)}`);
      }
    }
    const mutable: Record<string, unknown> = { role: entry["role"] };
    const assignString = (key: "ref" | "name" | "value" | "description"): void => {
      const value = entry[key];
      if (value !== undefined) {
        if (typeof value !== "string") {
          throw new BridgeError("INVALID_ENVELOPE", `malformed snapshot node field ${key}`);
        }
        mutable[key] = value;
      }
    };
    assignString("ref");
    assignString("name");
    assignString("value");
    assignString("description");
    const assignBoolean = (key: "disabled" | "focused" | "selected"): void => {
      const value = entry[key];
      if (value !== undefined) {
        if (typeof value !== "boolean") {
          throw new BridgeError("INVALID_ENVELOPE", `malformed snapshot node field ${key}`);
        }
        mutable[key] = value;
      }
    };
    assignBoolean("disabled");
    assignBoolean("focused");
    assignBoolean("selected");
    if (entry["checked"] !== undefined) {
      const checked = entry["checked"];
      if (checked !== true && checked !== false && checked !== "mixed") {
        throw new BridgeError("INVALID_ENVELOPE", "malformed snapshot node field checked");
      }
      mutable["checked"] = checked;
    }
    if (entry["expanded"] !== undefined) {
      if (typeof entry["expanded"] !== "boolean") {
        throw new BridgeError("INVALID_ENVELOPE", "malformed snapshot node field expanded");
      }
      mutable["expanded"] = entry["expanded"];
    }
    if (entry["level"] !== undefined) {
      if (typeof entry["level"] !== "number" || !Number.isInteger(entry["level"])) {
        throw new BridgeError("INVALID_ENVELOPE", "malformed snapshot node field level");
      }
      mutable["level"] = entry["level"];
    }
    return mutable as unknown as SnapshotNode;
  }

  async click(_ref: ElementRef): Promise<void> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("click");
    }
    await this.requireSelectedTab(selectedTabId, "click");
    try {
      await this.runtime.request(
        "interaction.click",
        { tabId: selectedTabId, ref: _ref },
        this.operationTimeoutMs(),
      );
    } catch (error: unknown) {
      throw this.interactionFailure(selectedTabId, "click", error);
    }
  }

  async fill(_ref: ElementRef, _text: string): Promise<void> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("fill");
    }
    this.requireTextSize(_text);
    await this.requireSelectedTab(selectedTabId, "fill");
    try {
      // Text travels only in the bridge payload; no log/error path echoes
      // it (see interactionFailure: length-only, secret-free messages).
      await this.runtime.request(
        "interaction.fill",
        { tabId: selectedTabId, ref: _ref, text: _text },
        this.operationTimeoutMs(),
      );
    } catch (error: unknown) {
      throw this.interactionFailure(selectedTabId, "fill", error);
    }
  }

  async type(_ref: ElementRef, _text: string): Promise<void> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("type");
    }
    this.requireTextSize(_text);
    await this.requireSelectedTab(selectedTabId, "type");
    try {
      await this.runtime.request(
        "interaction.type",
        { tabId: selectedTabId, ref: _ref, text: _text },
        this.operationTimeoutMs(),
      );
    } catch (error: unknown) {
      throw this.interactionFailure(selectedTabId, "type", error);
    }
  }

  async pressKey(_key: string): Promise<void> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("press a key on");
    }
    // Node-side allowlist first: reject before any bridge traffic.
    if ("error" in parsePressKey(_key)) {
      throw browserInvalidKey(_key);
    }
    await this.requireSelectedTab(selectedTabId, "press a key on");
    try {
      await this.runtime.request(
        "interaction.pressKey",
        { tabId: selectedTabId, key: _key },
        this.operationTimeoutMs(),
      );
    } catch (error: unknown) {
      throw this.interactionFailure(selectedTabId, "press key", error);
    }
  }

  async typeHuman(_ref: ElementRef, _text: string, _options?: TypeHumanOptions): Promise<void> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("human-type on");
    }
    this.requireTextSize(_text);
    const wpm = normalizeWpm(_options?.wpm);
    if (wpm === null) {
      throw browserInvalidText(0, INTERACTION_TEXT_LIMIT_BYTES);
    }
    if (_options?.wpm !== undefined && (wpm < HUMANIZE_WPM_MIN || wpm > HUMANIZE_WPM_MAX)) {
      throw browserInvalidText(0, INTERACTION_TEXT_LIMIT_BYTES);
    }
    await this.requireSelectedTab(selectedTabId, "human-type on");
    try {
      await this.runtime.request(
        "interaction.typeHuman",
        { tabId: selectedTabId, ref: _ref, text: _text, wpm },
        Math.max(this.operationTimeoutMs(), 30_000),
      );
    } catch (error: unknown) {
      throw this.interactionFailure(selectedTabId, "human type", error);
    }
  }

  async pressSequence(_keys: string[], _options?: PressSequenceOptions): Promise<void> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("press a key sequence on");
    }
    if (!Array.isArray(_keys) || _keys.length === 0 || _keys.length > PRESS_SEQUENCE_MAX_KEYS) {
      throw browserInvalidKey("(empty or oversized key sequence)");
    }
    for (const key of _keys) {
      if (typeof key !== "string" || "error" in parsePressKey(key)) {
        throw browserInvalidKey(typeof key === "string" ? key : "(non-string key)");
      }
    }
    const delayMs = normalizeSequenceDelayMs(_options?.delayMs);
    if (delayMs === null) {
      throw browserInvalidKey("(invalid sequence delay)");
    }
    if (
      _options?.delayMs !== undefined &&
      (_options.delayMs < HUMANIZE_SEQUENCE_DELAY_MIN_MS || _options.delayMs > HUMANIZE_SEQUENCE_DELAY_MAX_MS)
    ) {
      throw browserInvalidKey("(invalid sequence delay)");
    }
    await this.requireSelectedTab(selectedTabId, "press a key sequence on");
    try {
      await this.runtime.request(
        "interaction.pressSequence",
        { tabId: selectedTabId, keys: [..._keys], delayMs },
        Math.max(this.operationTimeoutMs(), 30_000),
      );
    } catch (error: unknown) {
      throw this.interactionFailure(selectedTabId, "press sequence", error);
    }
  }

  async clickType(_ref: ElementRef, _text: string, _options?: ClickTypeOptions): Promise<void> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("click-type on");
    }
    this.requireTextSize(_text);
    const humanize = _options?.humanize ?? true;
    if (typeof humanize !== "boolean") {
      throw browserInvalidText(0, INTERACTION_TEXT_LIMIT_BYTES);
    }
    const wpm = normalizeWpm(_options?.wpm);
    if (wpm === null) {
      throw browserInvalidText(0, INTERACTION_TEXT_LIMIT_BYTES);
    }
    const submitKey = _options?.submitKey;
    if (submitKey !== undefined && ("error" in parsePressKey(submitKey) || typeof submitKey !== "string")) {
      throw browserInvalidKey(typeof submitKey === "string" ? submitKey : "(invalid submit key)");
    }
    await this.requireSelectedTab(selectedTabId, "click-type on");
    try {
      await this.runtime.request(
        "interaction.clickType",
        {
          tabId: selectedTabId,
          ref: _ref,
          text: _text,
          humanize,
          wpm,
          ...(submitKey !== undefined ? { submitKey } : {}),
        },
        Math.max(this.operationTimeoutMs(), 30_000),
      );
    } catch (error: unknown) {
      throw this.interactionFailure(selectedTabId, "click-type", error);
    }
  }

  async getText(_ref?: ElementRef): Promise<string> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("read text from");
    }
    if (_ref === undefined) {
      throw browserStaleElement("(missing element reference)");
    }
    await this.requireSelectedTab(selectedTabId, "read text from");
    let payload: unknown;
    try {
      payload = await this.runtime.request(
        "interaction.getText",
        { tabId: selectedTabId, ref: _ref },
        this.operationTimeoutMs(),
      );
    } catch (error: unknown) {
      throw this.interactionFailure(selectedTabId, "get text", error);
    }
    return this.asElementText(payload).text;
  }

  /** Read-only element-text envelope; read-only, no ref invalidation here. */
  private asElementText(payload: unknown): ElementTextResult {
    if (!isRecord(payload) || typeof payload["text"] !== "string" || typeof payload["role"] !== "string") {
      throw browserSnapshotFailed("the extension returned a malformed text payload");
    }
    return { text: payload["text"], role: payload["role"], source: "accessibility" };
  }

  async evaluate(expression: string, options?: EvaluateOptions): Promise<EvaluateResult> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("evaluate JavaScript on");
    }
    // Node-side gates first (no bridge traffic, no ref churn on rejection):
    // required string, 64 KiB UTF-8 cap, bounded timeout.
    if (typeof expression !== "string" || expression.length === 0) {
      throw browserEvaluationFailed("empty expression");
    }
    const expressionBytes = pageToolsUtf8Length(expression);
    if (expressionBytes > EVALUATE_EXPRESSION_LIMIT_BYTES) {
      throw browserInvalidText(expressionBytes, EVALUATE_EXPRESSION_LIMIT_BYTES);
    }
    const requestedTimeout = options?.timeoutMs;
    if (
      requestedTimeout !== undefined &&
      (!Number.isInteger(requestedTimeout) || requestedTimeout < 1 || requestedTimeout > EVALUATE_MAX_TIMEOUT_MS)
    ) {
      throw browserEvaluationTimeout(
        Number.isInteger(requestedTimeout) ? (requestedTimeout as number) : EVALUATE_MAX_TIMEOUT_MS + 1,
      );
    }
    const timeoutMs = requestedTimeout ?? EVALUATE_DEFAULT_TIMEOUT_MS;
    await this.requireSelectedTab(selectedTabId, "evaluate JavaScript on");
    let payload: unknown;
    try {
      // The expression travels only in this bridge payload; no log or
      // error path below echoes it (see evaluateFailure: fixed messages).
      payload = await this.runtime.request(
        "runtime.evaluate",
        { tabId: selectedTabId, expression, timeoutMs },
        Math.max(this.operationTimeoutMs(), timeoutMs + 5_000),
      );
    } catch (error: unknown) {
      throw this.evaluateFailure(selectedTabId, timeoutMs, error);
    }
    return this.asEvaluateResult(payload);
  }

  /**
   * Validate the extension evaluate envelope and enforce the public result
   * cap Node-side (the extension enforces its own bound too). Secret
   * hygiene: the envelope carries only kind/value; raw RemoteObject shapes
   * and object handles fail closed here rather than leaking through.
   */
  private asEvaluateResult(payload: unknown): EvaluateResult {
    if (!isRecord(payload)) {
      throw new BridgeError("INVALID_ENVELOPE", "malformed runtime.evaluate payload from the extension bridge");
    }
    const kind = payload["kind"];
    if (
      kind !== "json" &&
      kind !== "undefined" &&
      kind !== "nan" &&
      kind !== "infinity" &&
      kind !== "neg-infinity" &&
      kind !== "neg-zero" &&
      kind !== "bigint"
    ) {
      throw new BridgeError("INVALID_ENVELOPE", "malformed runtime.evaluate result kind");
    }
    const resultKind = kind as EvaluateResultKind;
    if (resultKind === "undefined" || resultKind === "nan" || resultKind === "infinity" || resultKind === "neg-infinity" || resultKind === "neg-zero") {
      return { kind: resultKind };
    }
    if (resultKind === "bigint") {
      const value = payload["value"];
      if (typeof value !== "string" || !/^[+-]?[0-9]+$/.test(value)) {
        throw new BridgeError("INVALID_ENVELOPE", "malformed runtime.evaluate bigint result");
      }
      return { kind: "bigint", value };
    }
    const result: EvaluateResult = { kind: "json", value: payload["value"] };
    // Measure the actual serialized project result (kind + value), not
    // just the value: the cap covers the complete public result.
    let serializedBytes: number;
    try {
      serializedBytes = pageToolsUtf8Length(JSON.stringify(result) ?? "");
    } catch {
      throw browserEvaluationResultTooLarge(EVALUATE_RESULT_MAX_SERIALIZED_BYTES + 1, EVALUATE_RESULT_MAX_SERIALIZED_BYTES);
    }
    if (serializedBytes > EVALUATE_RESULT_MAX_SERIALIZED_BYTES) {
      throw browserEvaluationResultTooLarge(serializedBytes, EVALUATE_RESULT_MAX_SERIALIZED_BYTES);
    }
    return result;
  }

  /**
   * Map a bridge-side evaluate failure to the project taxonomy.
   * Fixed safe messages only: the expression source is never echoed, and
   * page-thrown data (which may itself be sensitive) is never surfaced.
   */
  private evaluateFailure(selectedTabId: TabId, timeoutMs: number, error: unknown): BrowserError {
    if (error instanceof BrowserError) {
      return error;
    }
    const remoteCode =
      error instanceof BridgeError && typeof error.details["remoteCode"] === "string"
        ? error.details["remoteCode"]
        : null;
    if (remoteCode === "TAB_NOT_FOUND" || remoteCode === "TAB_INVALID_ID") {
      this.selectedTabId = null;
      return browserTabNotFound(selectedTabId);
    }
    if (remoteCode === "TAB_NOT_CONTROLLABLE") {
      return browserTabNotControllable(selectedTabId, "(privileged source tab)");
    }
    if (remoteCode === "DEBUGGER_UNAVAILABLE") {
      return browserDebuggerUnavailable(selectedTabId, "the tab already has a debugger attached");
    }
    if (remoteCode === "EVALUATION_TIMEOUT") {
      return browserEvaluationTimeout(timeoutMs);
    }
    if (remoteCode === "EVALUATION_RESULT_TOO_LARGE") {
      return browserEvaluationResultTooLarge(
        EVALUATE_RESULT_MAX_SERIALIZED_BYTES + 1,
        EVALUATE_RESULT_MAX_SERIALIZED_BYTES,
      );
    }
    if (remoteCode !== null) {
      return browserEvaluationFailed(`extension rejected the evaluation (${remoteCode})`);
    }
    return browserEvaluationFailed("the bridge did not answer the evaluation request");
  }

  async screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    if (options?.fullPage === true) {
      throw browserScreenshotFailed("full-page capture is not supported; viewport only");
    }
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("capture a screenshot of");
    }
    await this.requireSelectedTab(selectedTabId, "capture a screenshot of");
    let payload: unknown;
    try {
      payload = await this.runtime.request(
        "page.screenshot",
        { tabId: selectedTabId },
        Math.max(this.operationTimeoutMs(), 30_000),
      );
    } catch (error: unknown) {
      throw this.screenshotFailure(selectedTabId, error);
    }
    // Read-only path: screenshot never invalidates refs (no call here).
    return this.asScreenshotResult(payload);
  }

  /**
   * Validate the extension screenshot envelope Node-side: base64 validity,
   * decoded cap, PNG signature, and the large-frame transport invariant.
   * Payload bytes are never logged; failures carry sizes/codes only.
   */
  private asScreenshotResult(payload: unknown): ScreenshotResult {
    if (!isRecord(payload) || payload["mimeType"] !== "image/png" || typeof payload["data"] !== "string") {
      throw browserScreenshotFailed("the browser returned a malformed screenshot payload")
    }
    const data = payload["data"] as string;
    const decodedBytes = decodedBase64Length(data);
    if (decodedBytes === null) {
      throw browserScreenshotFailed("the browser returned an invalid screenshot encoding");
    }
    if (decodedBytes > SCREENSHOT_DECODED_LIMIT_BYTES) {
      throw browserScreenshotTooLarge(decodedBytes, SCREENSHOT_DECODED_LIMIT_BYTES);
    }
    if (!hasPngSignature(decodeBase64Prefix(data, 8))) {
      throw browserScreenshotFailed("the browser returned a non-PNG screenshot");
    }
    // Transport invariant regression: the maximum legitimate response
    // (decoded cap expanded to base64 + envelope margin) must fit the
    // large-response frame. If a future envelope change breaks this, the
    // screenshot path must STOP rather than silently overflow transport.
    const maxWireBytes = Math.ceil(SCREENSHOT_DECODED_LIMIT_BYTES / 3) * 4 + 512;
    if (maxWireBytes > LARGE_RESPONSE_FRAME_MAX_BYTES) {
      throw browserScreenshotFailed("screenshot transport invariant violated");
    }
    if (data.length + 512 > LARGE_RESPONSE_FRAME_MAX_BYTES) {
      throw browserScreenshotTooLarge(decodedBytes, SCREENSHOT_DECODED_LIMIT_BYTES);
    }
    return { mimeType: "image/png", dataBase64: data };
  }

  /** Map a bridge-side screenshot failure to the project taxonomy. */
  private screenshotFailure(selectedTabId: TabId, error: unknown): BrowserError {
    if (error instanceof BrowserError) {
      return error;
    }
    const remoteCode =
      error instanceof BridgeError && typeof error.details["remoteCode"] === "string"
        ? error.details["remoteCode"]
        : null;
    if (remoteCode === "TAB_NOT_FOUND" || remoteCode === "TAB_INVALID_ID") {
      this.selectedTabId = null;
      return browserTabNotFound(selectedTabId);
    }
    if (remoteCode === "TAB_NOT_CONTROLLABLE") {
      return browserTabNotControllable(selectedTabId, "(privileged source tab)");
    }
    if (remoteCode === "DEBUGGER_UNAVAILABLE") {
      return browserDebuggerUnavailable(selectedTabId, "the tab already has a debugger attached");
    }
    if (remoteCode === "SCREENSHOT_TOO_LARGE") {
      return browserScreenshotTooLarge(SCREENSHOT_DECODED_LIMIT_BYTES + 1, SCREENSHOT_DECODED_LIMIT_BYTES);
    }
    if (remoteCode !== null) {
      return browserScreenshotFailed(`extension rejected the screenshot (${remoteCode})`);
    }
    return browserScreenshotFailed("the bridge did not answer the screenshot request");
  }

  async waitFor(condition: WaitCondition): Promise<WaitResult> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("wait on");
    }
    const spec = this.normalizeWaitCondition(condition);
    const startedTabId = selectedTabId;
    const deadline = nowMs() + spec.timeoutMs;
    const startedAt = nowMs();
    for (;;) {
      // Selection stability first on every poll: a changed selection
      // aborts (never retargets); a vanished tab fails closed. Same-tab
      // navigation is allowed and simply re-polls.
      const current = await this.status();
      if (current.selectedTabId !== startedTabId) {
        throw browserWaitAborted("the selected tab changed during the wait");
      }
      let tabs: BrowserTab[];
      try {
        tabs = await this.listTabs();
      } catch (error: unknown) {
        throw this.waitFailure(startedTabId, spec.label, error);
      }
      const tab = tabs.find((entry) => entry.id === startedTabId);
      if (tab === undefined) {
        this.selectedTabId = null;
        throw browserWaitAborted("the waited tab no longer exists");
      }
      if (!/^https?:/i.test(tab.url)) {
        throw browserTabNotControllable(startedTabId, tab.url === "" ? "(empty url)" : tab.url);
      }
      let check: { matched: boolean };
      try {
        const payload = await this.runtime.request("wait.check", spec.bridgePayload(startedTabId), this.operationTimeoutMs());
        check = this.asWaitCheck(payload);
      } catch (error: unknown) {
        throw this.waitFailure(startedTabId, spec.label, error);
      }
      if (check.matched) {
        return { matched: true, condition: spec.condition, elapsedMs: nowMs() - startedAt };
      }
      if (nowMs() >= deadline) {
        throw browserWaitTimeout(spec.label, spec.timeoutMs);
      }
      // Bounded poll cadence; remaining time is re-checked after waking.
      await delayMs(Math.min(WAIT_POLL_INTERVAL_MS, Math.max(1, deadline - nowMs())));
      if (nowMs() >= deadline) {
        // One final atomic poll already happened above on the next loop
        // iteration boundary; report the timeout deterministically.
        throw browserWaitTimeout(spec.label, spec.timeoutMs);
      }
    }
  }

  /** Normalize + bound the caller condition before any bridge traffic. */
  private normalizeWaitCondition(condition: WaitCondition): {
    condition: "load" | "url" | "title" | "text";
    label: string;
    timeoutMs: number;
    bridgePayload: (tabId: TabId) => Record<string, unknown>;
  } {
    const requestedTimeout = condition.timeoutMs;
    if (
      requestedTimeout !== undefined &&
      (!Number.isInteger(requestedTimeout) || requestedTimeout < WAIT_MIN_TIMEOUT_MS || requestedTimeout > WAIT_MAX_TIMEOUT_MS)
    ) {
      throw browserWaitTimeout("wait condition", this.clampWaitTimeout(requestedTimeout));
    }
    const timeoutMs = requestedTimeout ?? WAIT_DEFAULT_TIMEOUT_MS;
    switch (condition.type) {
      case "load": {
        return {
          condition: "load",
          label: "page load",
          timeoutMs,
          bridgePayload: (tabId) => ({ tabId, type: "load" }),
        };
      }
      case "url":
      case "title": {
        const match = condition.match;
        if (match !== "equals" && match !== "contains") {
          throw browserWaitTimeout(`wait ${condition.type}`, timeoutMs);
        }
        this.requireWaitValueSize(condition.value, condition.type);
        if (condition.value.length === 0) {
          throw browserWaitTimeout(`wait ${condition.type}`, timeoutMs);
        }
        const kind = condition.type;
        const value = condition.value;
        return {
          condition: kind,
          label: kind === "url" ? "URL" : "page title",
          timeoutMs,
          bridgePayload: (tabId) => ({ tabId, type: kind, match, value }),
        };
      }
      case "text": {
        this.requireWaitValueSize(condition.value, "text");
        if (condition.value.length === 0) {
          throw browserWaitTimeout("page text", timeoutMs);
        }
        const value = condition.value;
        return {
          condition: "text",
          label: "page text",
          timeoutMs,
          bridgePayload: (tabId) => ({ tabId, type: "text", value }),
        };
      }
    }
  }

  private clampWaitTimeout(requested: number | undefined): number {
    if (requested === undefined || !Number.isInteger(requested)) {
      return WAIT_MAX_TIMEOUT_MS;
    }
    if (requested < WAIT_MIN_TIMEOUT_MS) {
      return WAIT_MIN_TIMEOUT_MS;
    }
    return WAIT_MAX_TIMEOUT_MS;
  }

  /** Hard 4096 UTF-8 byte gate; rejects before any bridge traffic. */
  private requireWaitValueSize(value: string, kind: string): void {
    const bytes = pageToolsUtf8Length(value);
    if (bytes > WAIT_CONDITION_LIMIT_BYTES) {
      throw browserInvalidText(bytes, WAIT_CONDITION_LIMIT_BYTES);
    }
    void kind;
  }

  /** Validate the atomic wait.check envelope; fail closed on shape drift. */
  private asWaitCheck(payload: unknown): { matched: boolean } {
    if (!isRecord(payload) || typeof payload["matched"] !== "boolean") {
      throw new BridgeError("INVALID_ENVELOPE", "malformed wait.check payload from the extension bridge");
    }
    return { matched: payload["matched"] as boolean };
  }

  /**
   * Map a bridge-side wait failure to the project taxonomy. Condition text
   * is never echoed: length-only / code-only messages.
   */
  private waitFailure(selectedTabId: TabId, label: string, error: unknown): BrowserError {
    if (error instanceof BrowserError) {
      return error;
    }
    const remoteCode =
      error instanceof BridgeError && typeof error.details["remoteCode"] === "string"
        ? error.details["remoteCode"]
        : null;
    if (remoteCode === "TAB_NOT_FOUND" || remoteCode === "TAB_INVALID_ID") {
      this.selectedTabId = null;
      return browserWaitAborted("the waited tab no longer exists");
    }
    if (remoteCode === "TAB_NOT_CONTROLLABLE") {
      return browserTabNotControllable(selectedTabId, "(privileged tab during wait)");
    }
    if (remoteCode === "DEBUGGER_UNAVAILABLE") {
      return browserDebuggerUnavailable(selectedTabId, "the tab already has a debugger attached");
    }
    if (remoteCode === "WAIT_TIMEOUT") {
      return browserWaitTimeout(label, WAIT_DEFAULT_TIMEOUT_MS);
    }
    if (remoteCode === "WAIT_ABORTED") {
      return browserWaitAborted("the wait was aborted by the extension");
    }
    if (remoteCode !== null) {
      return browserWaitAborted(`the wait was rejected by the extension (${remoteCode})`);
    }
    return browserWaitAborted("the bridge did not answer the wait request");
  }

  /**
   * Reconcile logical selection through authoritative tab state before any
   * mutating/read interaction: a vanished tab heals to null and fails
   * TAB_NOT_FOUND; a privileged source fails TAB_NOT_CONTROLLABLE before
   * any interaction RPC. Never falls back to another tab.
   */
  private async requireSelectedTab(selectedTabId: TabId, operation: string): Promise<BrowserTab> {
    let tabs: BrowserTab[];
    try {
      tabs = await this.listTabs();
    } catch (error: unknown) {
      if (error instanceof BrowserError && error.code === "BROWSER_TAB_NOT_FOUND") {
        this.selectedTabId = null;
        throw browserTabNotFound(selectedTabId);
      }
      throw error;
    }
    const selected = tabs.find((tab) => tab.id === selectedTabId);
    if (selected === undefined) {
      this.selectedTabId = null;
      throw browserTabNotFound(selectedTabId);
    }
    if (!/^https?:/i.test(selected.url)) {
      throw browserTabNotControllable(selectedTabId, selected.url === "" ? "(empty url)" : selected.url);
    }
    void operation;
    return selected;
  }

  /** Hard byte-limit gate for fill/type; rejects before any bridge traffic. */
  private requireTextSize(text: string): void {
    const bytes = utf8ByteLength(text);
    if (bytes > INTERACTION_TEXT_LIMIT_BYTES) {
      throw browserInvalidText(bytes, INTERACTION_TEXT_LIMIT_BYTES);
    }
  }

  /**
   * Map a bridge-side interaction failure to the project taxonomy.
   * Secret-bearing payloads are never echoed: length-only / code-only
   * messages only. Stale refs fail closed; debugger conflicts never steal.
   */
  private interactionFailure(selectedTabId: TabId, operation: string, error: unknown): BrowserError {
    if (error instanceof BrowserError) {
      return error;
    }
    const remoteCode =
      error instanceof BridgeError && typeof error.details["remoteCode"] === "string"
        ? error.details["remoteCode"]
        : null;
    if (remoteCode === "TAB_NOT_FOUND" || remoteCode === "TAB_INVALID_ID") {
      this.selectedTabId = null;
      return browserTabNotFound(selectedTabId);
    }
    if (remoteCode === "TAB_NOT_CONTROLLABLE") {
      return browserTabNotControllable(selectedTabId, "(privileged source tab)");
    }
    if (remoteCode === "DEBUGGER_UNAVAILABLE") {
      const message = error instanceof Error ? error.message : String(error);
      return browserDebuggerUnavailable(selectedTabId, message);
    }
    if (remoteCode === "STALE_ELEMENT") {
      return browserStaleElement("(stale element reference)");
    }
    if (remoteCode === "ELEMENT_NOT_INTERACTABLE") {
      return browserElementNotInteractable(`the ${operation} target cannot be activated`);
    }
    if (remoteCode === "ELEMENT_NOT_EDITABLE") {
      return browserElementNotEditable(`the ${operation} target is not an editable text control`);
    }
    if (remoteCode === "INVALID_KEY") {
      return browserInvalidKey("(unsupported key)");
    }
    if (remoteCode === "INVALID_TEXT") {
      return browserInvalidText(0, INTERACTION_TEXT_LIMIT_BYTES);
    }
    if (remoteCode !== null) {
      return browserInteractionFailed(`${operation} rejected by the extension (${remoteCode})`, error);
    }
    return browserInteractionFailed(operation, error);
  }

  // Observability (read-only; never invalidates refs, never mutates).

  /** Resolve the configured console capacity (throws typed config error). */
  private consoleCapacity(): number {
    const raw = this.options.consoleBufferEntries;
    if (raw === undefined) {
      return CONSOLE_BUFFER_DEFAULT_ENTRIES;
    }
    if (!Number.isInteger(raw) || raw <= 0 || raw > CONSOLE_BUFFER_HARD_MAX_ENTRIES) {
      throw browserObservabilityConfigInvalid(
        "consoleBufferEntries",
        `expected a positive integer 1-${String(CONSOLE_BUFFER_HARD_MAX_ENTRIES)}`,
      );
    }
    return raw;
  }

  /** Resolve the configured network capacity (throws typed config error). */
  private networkCapacity(): number {
    const raw = this.options.networkBufferEntries;
    if (raw === undefined) {
      return NETWORK_BUFFER_DEFAULT_ENTRIES;
    }
    if (!Number.isInteger(raw) || raw <= 0 || raw > NETWORK_BUFFER_HARD_MAX_ENTRIES) {
      throw browserObservabilityConfigInvalid(
        "networkBufferEntries",
        `expected a positive integer 1-${String(NETWORK_BUFFER_HARD_MAX_ENTRIES)}`,
      );
    }
    return raw;
  }

  /** Normalize a get limit (default 100, hard max 500). */
  private observabilityLimit(limit: number | undefined, kind: "console" | "network"): number {
    void kind;
    if (limit === undefined) {
      return 100;
    }
    if (!Number.isInteger(limit) || limit <= 0 || limit > OBSERVABILITY_MAX_RETRIEVAL_LIMIT) {
      throw browserObservabilityFailed(kind === "console" ? "retrieve console" : "retrieve network", "INVALID_LIMIT");
    }
    return limit;
  }

  async getConsole(limit?: number): Promise<ConsoleResult> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("read console entries from");
    }
    const safeLimit = this.observabilityLimit(limit, "console");
    const capacity = this.consoleCapacity();
    await this.requireSelectedTab(selectedTabId, "read console entries from");
    let payload: unknown;
    try {
      payload = await this.runtime.request(
        "observability.consoleGet",
        { tabId: selectedTabId, limit: safeLimit, capacity },
        this.operationTimeoutMs(),
      );
    } catch (error: unknown) {
      throw this.observabilityFailure(selectedTabId, "retrieve console", error);
    }
    return this.asConsoleResult(selectedTabId, payload);
  }

  async clearConsole(): Promise<{ cleared: true; removedEntries: number; monitoring: boolean }> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("clear console entries on");
    }
    // Configures capacity deterministically even for clear (fail fast on
    // invalid config before any bridge traffic), matching get semantics.
    const capacity = this.consoleCapacity();
    void capacity;
    await this.requireSelectedTab(selectedTabId, "clear console entries on");
    let payload: unknown;
    try {
      payload = await this.runtime.request(
        "observability.consoleClear",
        { tabId: selectedTabId },
        this.operationTimeoutMs(),
      );
    } catch (error: unknown) {
      throw this.observabilityFailure(selectedTabId, "clear console", error);
    }
    return this.asConsoleClear(payload);
  }

  async getNetwork(limit?: number): Promise<NetworkResult> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("read network entries from");
    }
    const safeLimit = this.observabilityLimit(limit, "network");
    const capacity = this.networkCapacity();
    await this.requireSelectedTab(selectedTabId, "read network entries from");
    let payload: unknown;
    try {
      payload = await this.runtime.request(
        "observability.networkGet",
        { tabId: selectedTabId, limit: safeLimit, capacity },
        this.operationTimeoutMs(),
      );
    } catch (error: unknown) {
      throw this.observabilityFailure(selectedTabId, "retrieve network", error);
    }
    return this.asNetworkResult(selectedTabId, payload);
  }

  async clearNetwork(): Promise<{ cleared: true; removedEntries: number; monitoring: boolean }> {
    const selectedTabId = this.selectedTabId;
    if (selectedTabId === null) {
      throw browserNoSelectedTab("clear network entries on");
    }
    const capacity = this.networkCapacity();
    void capacity;
    await this.requireSelectedTab(selectedTabId, "clear network entries on");
    let payload: unknown;
    try {
      payload = await this.runtime.request(
        "observability.networkClear",
        { tabId: selectedTabId },
        this.operationTimeoutMs(),
      );
    } catch (error: unknown) {
      throw this.observabilityFailure(selectedTabId, "clear network", error);
    }
    return this.asNetworkClear(payload);
  }

  /** Validate the console get envelope; re-redact Node-side. */
  private asConsoleResult(selectedTabId: TabId, payload: unknown): ConsoleResult {
    if (!isRecord(payload)) {
      throw new BridgeError("INVALID_ENVELOPE", "malformed observability.consoleGet payload from the extension bridge");
    }
    for (const key of Object.keys(payload)) {
      if (
        key !== "tabId" &&
        key !== "monitoring" &&
        key !== "capacity" &&
        key !== "availableEntries" &&
        key !== "returnedEntries" &&
        key !== "droppedCount" &&
        key !== "truncated" &&
        key !== "entries"
      ) {
        throw browserObservabilityFailed("retrieve console", "INVALID_ENVELOPE");
      }
    }
    if (
      payload["tabId"] !== selectedTabId ||
      payload["monitoring"] !== true ||
      typeof payload["capacity"] !== "number" ||
      typeof payload["availableEntries"] !== "number" ||
      typeof payload["returnedEntries"] !== "number" ||
      typeof payload["droppedCount"] !== "number" ||
      typeof payload["truncated"] !== "boolean" ||
      !Array.isArray(payload["entries"])
    ) {
      throw new BridgeError("INVALID_ENVELOPE", "malformed observability.consoleGet payload from the extension bridge");
    }
    const entries = (payload["entries"] as unknown[]).map((entry) => this.asConsoleEntry(entry));
    const result: ConsoleResult = {
      tabId: selectedTabId,
      monitoring: true,
      capacity: payload["capacity"] as number,
      availableEntries: payload["availableEntries"] as number,
      returnedEntries: entries.length,
      droppedCount: payload["droppedCount"] as number,
      truncated: payload["truncated"] as boolean,
      entries,
    };
    const leaked = findLeakedCdpKeys(result);
    if (leaked.length > 0) {
      throw browserObservabilityFailed("retrieve console", "INVALID_ENVELOPE");
    }
    // Response budget: the extension already budgets, but
    // Node re-checks the exact public envelope before MCP output.
    if (observabilityUtf8Length(JSON.stringify(result) ?? "") > OBSERVABILITY_MAX_SERIALIZED_BYTES) {
      throw browserObservabilityFailed("retrieve console", "RESPONSE_TOO_LARGE");
    }
    return result;
  }

  /** Validate one console entry; re-apply heuristic redaction + URL sanitize. */
  private asConsoleEntry(entry: unknown): ConsoleEntry {
    if (!isRecord(entry) || typeof entry["timestamp"] !== "string" || typeof entry["text"] !== "string") {
      throw new BridgeError("INVALID_ENVELOPE", "malformed console entry from the extension bridge");
    }
    const level = entry["level"];
    if (level !== "log" && level !== "info" && level !== "warning" && level !== "error" && level !== "debug") {
      throw new BridgeError("INVALID_ENVELOPE", "malformed console entry level from the extension bridge");
    }
    for (const key of Object.keys(entry)) {
      if (key !== "timestamp" && key !== "level" && key !== "text" && key !== "source") {
        throw browserObservabilityFailed("retrieve console", "INVALID_ENVELOPE");
      }
    }
    const sanitized: ConsoleEntry = {
      timestamp: (entry["timestamp"] as string).slice(0, 64),
      level,
      text: redactConsoleText(entry["text"] as string, 4000),
    };
    if (entry["source"] !== undefined) {
      if (!isRecord(entry["source"])) {
        throw new BridgeError("INVALID_ENVELOPE", "malformed console entry source from the extension bridge");
      }
      const source = entry["source"] as Record<string, unknown>;
      for (const key of Object.keys(source)) {
        if (key !== "url" && key !== "line" && key !== "column") {
          throw browserObservabilityFailed("retrieve console", "INVALID_ENVELOPE");
        }
      }
      const projected: { url?: string; line?: number; column?: number } = {};
      if (source["url"] !== undefined) {
        if (typeof source["url"] !== "string") {
          throw new BridgeError("INVALID_ENVELOPE", "malformed console entry source url");
        }
        projected.url = sanitizeUrl(source["url"] as string, 2048);
      }
      if (source["line"] !== undefined) {
        if (typeof source["line"] !== "number" || !Number.isInteger(source["line"] as number)) {
          throw new BridgeError("INVALID_ENVELOPE", "malformed console entry source line");
        }
        projected.line = source["line"] as number;
      }
      if (source["column"] !== undefined) {
        if (typeof source["column"] !== "number" || !Number.isInteger(source["column"] as number)) {
          throw new BridgeError("INVALID_ENVELOPE", "malformed console entry source column");
        }
        projected.column = source["column"] as number;
      }
      if (projected.url !== undefined || projected.line !== undefined || projected.column !== undefined) {
        (sanitized as { source?: ConsoleEntry["source"] }).source = projected;
      }
    }
    return sanitized;
  }

  private asConsoleClear(payload: unknown): { cleared: true; removedEntries: number; monitoring: boolean } {
    if (!isRecord(payload) || payload["cleared"] !== true || typeof payload["removedEntries"] !== "number") {
      throw new BridgeError("INVALID_ENVELOPE", "malformed observability.consoleClear payload from the extension bridge");
    }
    return {
      cleared: true,
      removedEntries: payload["removedEntries"] as number,
      monitoring: payload["monitoring"] === true,
    };
  }

  /** Validate the network get envelope; re-redact Node-side. */
  private asNetworkResult(selectedTabId: TabId, payload: unknown): NetworkResult {
    if (!isRecord(payload)) {
      throw new BridgeError("INVALID_ENVELOPE", "malformed observability.networkGet payload from the extension bridge");
    }
    for (const key of Object.keys(payload)) {
      if (
        key !== "tabId" &&
        key !== "monitoring" &&
        key !== "capacity" &&
        key !== "availableEntries" &&
        key !== "returnedEntries" &&
        key !== "droppedCount" &&
        key !== "truncated" &&
        key !== "entries"
      ) {
        throw browserObservabilityFailed("retrieve network", "INVALID_ENVELOPE");
      }
    }
    if (
      payload["tabId"] !== selectedTabId ||
      payload["monitoring"] !== true ||
      typeof payload["capacity"] !== "number" ||
      typeof payload["availableEntries"] !== "number" ||
      typeof payload["returnedEntries"] !== "number" ||
      typeof payload["droppedCount"] !== "number" ||
      typeof payload["truncated"] !== "boolean" ||
      !Array.isArray(payload["entries"])
    ) {
      throw new BridgeError("INVALID_ENVELOPE", "malformed observability.networkGet payload from the extension bridge");
    }
    const entries = (payload["entries"] as unknown[]).map((entry) => this.asNetworkEntry(entry));
    const result: NetworkResult = {
      tabId: selectedTabId,
      monitoring: true,
      capacity: payload["capacity"] as number,
      availableEntries: payload["availableEntries"] as number,
      returnedEntries: entries.length,
      droppedCount: payload["droppedCount"] as number,
      truncated: payload["truncated"] as boolean,
      entries,
    };
    const leaked = findLeakedCdpKeys(result);
    if (leaked.length > 0) {
      throw browserObservabilityFailed("retrieve network", "INVALID_ENVELOPE");
    }
    if (observabilityUtf8Length(JSON.stringify(result) ?? "") > OBSERVABILITY_MAX_SERIALIZED_BYTES) {
      throw browserObservabilityFailed("retrieve network", "RESPONSE_TOO_LARGE");
    }
    return result;
  }

  /** Validate one network entry; re-apply header/URL redaction Node-side. */
  private asNetworkEntry(entry: unknown): NetworkEntry {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || typeof entry["url"] !== "string" || typeof entry["method"] !== "string") {
      throw new BridgeError("INVALID_ENVELOPE", "malformed network entry from the extension bridge");
    }
    for (const key of Object.keys(entry)) {
      if (
        key !== "id" &&
        key !== "startedAt" &&
        key !== "method" &&
        key !== "url" &&
        key !== "resourceType" &&
        key !== "requestHeaders" &&
        key !== "hasPostData" &&
        key !== "status" &&
        key !== "statusText" &&
        key !== "responseHeaders" &&
        key !== "mimeType" &&
        key !== "protocol" &&
        key !== "fromDiskCache" &&
        key !== "failed" &&
        key !== "errorText"
      ) {
        throw browserObservabilityFailed("retrieve network", "INVALID_ENVELOPE");
      }
    }
    const record = entry as Record<string, unknown>;
    const projected: Record<string, unknown> = {
      id: (record["id"] as string).slice(0, 64),
      startedAt: typeof record["startedAt"] === "string" ? (record["startedAt"] as string).slice(0, 64) : "",
      method: (record["method"] as string).slice(0, 16),
      url: sanitizeUrl(record["url"] as string, 2048),
      requestHeaders: isRecord(record["requestHeaders"])
        ? redactHeaders(record["requestHeaders"] as Record<string, string>, 1024)
        : {},
      hasPostData: record["hasPostData"] === true,
    };
    if (record["resourceType"] !== undefined) {
      if (typeof record["resourceType"] !== "string") {
        throw new BridgeError("INVALID_ENVELOPE", "malformed network entry resourceType");
      }
      projected["resourceType"] = (record["resourceType"] as string).slice(0, 64);
    }
    if (record["status"] !== undefined) {
      if (typeof record["status"] !== "number") {
        throw new BridgeError("INVALID_ENVELOPE", "malformed network entry status");
      }
      projected["status"] = record["status"];
    }
    if (record["statusText"] !== undefined) {
      if (typeof record["statusText"] !== "string") {
        throw new BridgeError("INVALID_ENVELOPE", "malformed network entry statusText");
      }
      projected["statusText"] = (record["statusText"] as string).slice(0, 128);
    }
    if (record["responseHeaders"] !== undefined) {
      if (!isRecord(record["responseHeaders"])) {
        throw new BridgeError("INVALID_ENVELOPE", "malformed network entry responseHeaders");
      }
      projected["responseHeaders"] = redactHeaders(record["responseHeaders"] as Record<string, string>, 1024);
    }
    if (record["mimeType"] !== undefined) {
      if (typeof record["mimeType"] !== "string") {
        throw new BridgeError("INVALID_ENVELOPE", "malformed network entry mimeType");
      }
      projected["mimeType"] = (record["mimeType"] as string).slice(0, 128);
    }
    if (record["protocol"] !== undefined) {
      if (typeof record["protocol"] !== "string") {
        throw new BridgeError("INVALID_ENVELOPE", "malformed network entry protocol");
      }
      projected["protocol"] = (record["protocol"] as string).slice(0, 64);
    }
    if (record["fromDiskCache"] !== undefined) {
      if (typeof record["fromDiskCache"] !== "boolean") {
        throw new BridgeError("INVALID_ENVELOPE", "malformed network entry fromDiskCache");
      }
      projected["fromDiskCache"] = record["fromDiskCache"];
    }
    if (record["failed"] !== undefined) {
      if (typeof record["failed"] !== "boolean") {
        throw new BridgeError("INVALID_ENVELOPE", "malformed network entry failed");
      }
      projected["failed"] = record["failed"];
    }
    if (record["errorText"] !== undefined) {
      if (typeof record["errorText"] !== "string") {
        throw new BridgeError("INVALID_ENVELOPE", "malformed network entry errorText");
      }
      projected["errorText"] = (record["errorText"] as string).slice(0, 256);
    }
    return projected as unknown as NetworkEntry;
  }

  private asNetworkClear(payload: unknown): { cleared: true; removedEntries: number; monitoring: boolean } {
    if (!isRecord(payload) || payload["cleared"] !== true || typeof payload["removedEntries"] !== "number") {
      throw new BridgeError("INVALID_ENVELOPE", "malformed observability.networkClear payload from the extension bridge");
    }
    return {
      cleared: true,
      removedEntries: payload["removedEntries"] as number,
      monitoring: payload["monitoring"] === true,
    };
  }

  /**
   * Map a bridge-side observability failure to the project taxonomy.
   * Fixed safe messages only: headers, URLs, console payloads, and event
   * bodies never flow through here (length/code info only).
   */
  private observabilityFailure(selectedTabId: TabId, operation: string, error: unknown): BrowserError {
    if (error instanceof BrowserError) {
      return error;
    }
    const remoteCode =
      error instanceof BridgeError && typeof error.details["remoteCode"] === "string"
        ? error.details["remoteCode"]
        : null;
    if (remoteCode === "TAB_NOT_FOUND" || remoteCode === "TAB_INVALID_ID") {
      this.selectedTabId = null;
      return browserTabNotFound(selectedTabId);
    }
    if (remoteCode === "TAB_NOT_CONTROLLABLE") {
      return browserTabNotControllable(selectedTabId, "(privileged source tab)");
    }
    if (remoteCode === "DEBUGGER_UNAVAILABLE") {
      return browserDebuggerUnavailable(selectedTabId, "the tab already has a debugger attached");
    }
    if (remoteCode === "OBSERVABILITY_CONFIG_INVALID") {
      return browserObservabilityConfigInvalid(
        operation.includes("console") ? "consoleBufferEntries" : "networkBufferEntries",
        "the extension rejected the configured capacity",
      );
    }
    if (remoteCode !== null) {
      return browserObservabilityFailed(operation, remoteCode, error);
    }
    return browserObservabilityFailed(operation, null, error);
  }
}
