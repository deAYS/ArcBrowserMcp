/**
 * Shared diagnostic types.
 *
 * This module is intentionally free of DOM APIs and the global `chrome`
 * object so the same orchestration code is typechecked by both the
 * extension build and the root vitest suite (which mocks the browser API).
 */

export type CheckStatus = "pass" | "fail" | "skipped_security" | "not_tested";

export interface TabCheck {
  readonly create: CheckStatus;
  readonly query: CheckStatus;
  readonly update: CheckStatus;
  readonly remove: CheckStatus;
}

export interface DebuggerCheck {
  readonly attach: CheckStatus;
  readonly detach: CheckStatus;
}

export interface CdpCheck {
  readonly Runtime: CheckStatus;
  readonly DOM: CheckStatus;
  readonly Accessibility: CheckStatus;
  readonly DOMSnapshot: CheckStatus;
  readonly Page: CheckStatus;
  readonly Page_captureScreenshot: CheckStatus;
  readonly Network: CheckStatus;
  readonly Input: CheckStatus;
  readonly Target: CheckStatus;
  readonly Storage: CheckStatus;
}

export interface CapabilityMatrix {
  readonly tabs: TabCheck;
  readonly debugger: DebuggerCheck;
  readonly cdp: CdpCheck;
}

export type FeasibilityVerdict = "SUPPORTED" | "BLOCKED";

/** Live snapshot of an in-flight diagnostics run (polled by the UI). */
export interface DiagnosticProgress {
  readonly running: boolean;
  readonly currentCheck: string | null;
  readonly capabilities: CapabilityMatrix;
  readonly startedAt: string;
}

export interface DiagnosticReport {
  readonly arcVersion: string;
  readonly chromiumVersion: string;
  readonly manifestVersion: 3;
  readonly testUrl: string;
  readonly testTabId: number | null;
  readonly capabilities: CapabilityMatrix;
  /** Check key -> human-readable failure message (only for failures). */
  readonly errors: Record<string, string>;
  /** Check key -> small safe evidence (counts, lengths, sample roles). */
  readonly evidence: Record<string, string | number | boolean>;
  readonly verdict: FeasibilityVerdict;
  readonly notes: string[];
}

/** Minimal tab shape used by the runner (subset of chrome.tabs.Tab). */
export interface TestTab {
  readonly id: number | undefined;
  readonly url: string | undefined;
  readonly title: string | undefined;
  readonly status: string | undefined;
}

/** Listener for tab updates filtered to one tab (subset of chrome.tabs.onUpdated). */
export type TabUpdatedListener = (
  tabId: number,
  changeInfo: { status?: string; url?: string },
) => void;

/** Debugger target used by the runner (subset of chrome.debugger.Debuggee). */
export interface DebugTarget {
  readonly tabId: number;
}

/** Debugger target summary (subset of chrome.debugger.TargetInfo, no URLs/titles). */
export interface DebugTargetSummary {
  readonly tabId: number | undefined;
  readonly type: string;
}

/**
 * Structural subset of the extension APIs the runner needs. The background
 * worker adapts the real `chrome.*` namespaces to this shape; unit tests
 * inject fakes. No host permissions are required for any of these calls.
 */
export interface ChromeApi {
  readonly tabs: {
    create(properties: { url: string; active?: boolean }): Promise<TestTab>;
    get(tabId: number): Promise<TestTab>;
    query(queryInfo: { url?: string }): Promise<TestTab[]>;
    update(tabId: number, properties: { active?: boolean; url?: string }): Promise<TestTab>;
    reload(tabId: number): Promise<void>;
    remove(tabId: number): Promise<void>;
    onUpdated(listener: TabUpdatedListener): void;
    removeOnUpdatedListener(listener: TabUpdatedListener): void;
  };
  readonly debugger: {
    attach(target: DebugTarget, protocolVersion: string): Promise<void>;
    sendCommand(
      target: DebugTarget,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
    detach(target: DebugTarget): Promise<void>;
    onEvent(
      listener: (
        source: { tabId?: number },
        method: string,
        params?: Record<string, unknown>,
      ) => void,
    ): void;
    onDetach(listener: (source: { tabId?: number }, reason: string) => void): void;
    /** Optional target enumeration via chrome.debugger.getTargets (never a CDP command). */
    getTargets(): Promise<DebugTargetSummary[]>;
  };
  /** Browser identity for the report (background parses the user agent). */
  versions(): { arc: string; chromium: string };
}
