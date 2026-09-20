/**
 * Shared browser-domain models owned by this project.
 *
 * These types are intentionally backend-agnostic: no Playwright, CDP,
 * Chrome, or Arc-specific library types may appear here. Later phases
 * (snapshots, observability, recovery) will extend these models without
 * breaking the BrowserEngine contract.
 */

/** Stable identifier for a browser tab managed by the MCP server. */
export type TabId = string;

/**
 * Opaque reference to an actionable element from a page snapshot.
 * P02 defines only the alias; P06 (RefRegistry) defines resolution semantics.
 */
export type ElementRef = string;

export type BrowserConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type BrowserBackend = "none" | "cdp" | "extension";

export type BrowserProfileMode = "dedicated-mcp-profile" | "normal-running-arc";

export interface BrowserStatus {
  readonly connected: boolean;
  readonly state: BrowserConnectionState;
  readonly backend: BrowserBackend;
  readonly profileMode: BrowserProfileMode;
  readonly selectedTabId: TabId | null;
  readonly reason?: string;
  readonly cdpPort?: number;
  readonly discoverySource?: string;
  readonly contextCount?: number;
  readonly lastErrorCode?: string;
  readonly extensionConnected?: boolean;
  readonly relayConnected?: boolean;
  readonly pipeAuthenticated?: boolean;
  readonly bridgeProtocolVersion?: number;
  readonly extensionId?: string;
}

export interface BrowserTab {
  readonly id: TabId;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly windowId: number;
  /**
   * Whether normal page-control operations are expected to work against
   * this tab. Deterministic rule: normal http/https pages are controllable;
   * browser-internal schemes are listed but flagged otherwise (P05/P06
   * will rely on this rather than rediscovering it).
   */
  readonly controllable: boolean;
}

export interface NavigateRequest {
  readonly url: string;
}

export type NavigationAction = "navigate" | "back" | "forward" | "reload";

export interface NavigateResult {
  /** Which navigation command was accepted. */
  readonly action: NavigationAction;
  /** The command was accepted by the browser; NOT a full-load guarantee. */
  readonly accepted: true;
  /** The URL that was requested (navigate only). */
  readonly requestedUrl?: string;
  /** Best-effort current tab snapshot right after acceptance; browser truth reconciles on next listTabs(). */
  readonly tab: BrowserTab;
}

export interface SnapshotNode {
  /** Project-owned opaque element ref (P07 input); absent for static text. */
  readonly ref?: string;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly focused?: boolean;
  readonly selected?: boolean;
  readonly checked?: boolean | "mixed";
  readonly expanded?: boolean;
  readonly level?: number;
}

export interface SnapshotOptions {
  /** Soft cap on included nodes; bounded by hard caps extension-side. */
  readonly maxNodes?: number;
}

export interface SnapshotResult {
  readonly snapshotId: string;
  readonly tabId: TabId;
  readonly url: string;
  readonly title: string;
  readonly nodes: readonly SnapshotNode[];
  /** Compact agent-oriented rendering, e.g. `[link ref=e-...] Learn more`. */
  readonly text: string;
  readonly truncated: boolean;
  readonly totalNodes: number;
  readonly includedNodes: number;
}

export interface InteractionResult {
  readonly accepted: true;
}

export interface ElementTextResult {
  readonly text: string;
  readonly role: string;
  readonly source: "accessibility";
}

export interface ScreenshotOptions {
  /**
   * P08 supports viewport capture only. Requesting fullPage: true is
   * rejected (BROWSER_SCREENSHOT_FAILED); the field exists so future
   * phases can extend without breaking the contract.
   */
  readonly fullPage?: boolean;
}

export interface ScreenshotResult {
  readonly mimeType: "image/png";
  readonly dataBase64: string;
}

/** Options for browser_evaluate (P08). Timeout is bounded by policy. */
export interface EvaluateOptions {
  /** Per-evaluation deadline in ms; default 5000, hard max 10000. */
  readonly timeoutMs?: number;
}

/**
 * Project-owned by-value evaluation result (P08).
 *
 * Arbitrary page JS can produce values JSON cannot represent, so the
 * envelope distinguishes plain JSON-compatible results from special JS
 * values instead of silently coercing them:
 * - { kind: "json", value } — null, boolean, string, finite number,
 *   arrays, plain by-value objects.
 * - { kind: "undefined" } — the expression evaluated to undefined.
 * - { kind: "nan" | "infinity" | "neg-infinity" | "neg-zero" }.
 * - { kind: "bigint", value } — value is the decimal digit string.
 *
 * No remote object handles, execution contexts, or raw CDP shapes ever
 * appear here; non-serializable results are rejected, not exposed.
 */
export type EvaluateResultKind =
  | "json"
  | "undefined"
  | "nan"
  | "infinity"
  | "neg-infinity"
  | "neg-zero"
  | "bigint";

export interface EvaluateResult {
  readonly kind: EvaluateResultKind;
  /** Present for kind "json" (the by-value result) and "bigint" (decimal digits). */
  readonly value?: unknown;
}

/**
 * Bounded semantic wait conditions (P08). No arbitrary JS polling:
 * load/url/title resolve against authoritative tab metadata, text
 * resolves against a dedicated read-only Accessibility inspection that
 * never allocates snapshot refs. Matching is case-sensitive and
 * deterministic; url/title support equals|contains, text is contains.
 */
export type WaitCondition =
  | { readonly type: "load"; readonly timeoutMs?: number }
  | { readonly type: "url"; readonly match: "equals" | "contains"; readonly value: string; readonly timeoutMs?: number }
  | { readonly type: "title"; readonly match: "equals" | "contains"; readonly value: string; readonly timeoutMs?: number }
  | { readonly type: "text"; readonly value: string; readonly timeoutMs?: number };

export interface WaitResult {
  readonly matched: true;
  readonly condition: "load" | "url" | "title" | "text";
  readonly elapsedMs: number;
}

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

export interface ConsoleResult {
  readonly tabId: TabId;
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

export type ObservabilityAction = "get" | "clear";

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

export interface NetworkResult {
  readonly tabId: TabId;
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
