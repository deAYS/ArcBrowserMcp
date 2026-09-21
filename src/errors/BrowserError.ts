/**
 * Typed errors for browser discovery, launch, and CDP connection.
 *
 * Minimal on purpose. Every error
 * carries a stable machine-readable code so callers never match on message
 * strings, plus an actionable human-readable message and safe details.
 * Original failures are retained through `cause` where available.
 */

export type BrowserErrorCode =
  | "BROWSER_EXECUTABLE_NOT_FOUND"
  | "BROWSER_EXECUTABLE_PATH_INVALID"
  | "BROWSER_PROFILE_PATH_UNSAFE"
  | "BROWSER_LAUNCH_FAILED"
  | "BROWSER_CDP_PORT_IN_USE"
  | "BROWSER_PROCESS_EXITED_EARLY"
  | "BROWSER_CDP_READY_TIMEOUT"
  | "BROWSER_CDP_CONNECT_FAILED"
  | "BROWSER_CDP_NO_CONTEXT"
  | "BROWSER_OPERATION_NOT_IMPLEMENTED"
  | "BROWSER_TAB_NOT_FOUND"
  | "BROWSER_TAB_CREATE_FAILED"
  | "BROWSER_TAB_CLOSE_FAILED"
  | "BROWSER_NO_SELECTED_TAB"
  | "BROWSER_URL_NOT_ALLOWED"
  | "BROWSER_TAB_NOT_CONTROLLABLE"
  | "BROWSER_HISTORY_UNAVAILABLE"
  | "BROWSER_NAVIGATION_FAILED"
  | "BROWSER_SNAPSHOT_FAILED"
  | "BROWSER_DEBUGGER_UNAVAILABLE"
  | "BROWSER_STALE_ELEMENT"
  | "BROWSER_ELEMENT_NOT_INTERACTABLE"
  | "BROWSER_ELEMENT_NOT_EDITABLE"
  | "BROWSER_INVALID_KEY"
  | "BROWSER_INTERACTION_FAILED"
  | "BROWSER_INVALID_TEXT"
  | "BROWSER_EVALUATION_FAILED"
  | "BROWSER_EVALUATION_TIMEOUT"
  | "BROWSER_EVALUATION_RESULT_TOO_LARGE"
  | "BROWSER_SCREENSHOT_FAILED"
  | "BROWSER_SCREENSHOT_TOO_LARGE"
  | "BROWSER_WAIT_TIMEOUT"
  | "BROWSER_WAIT_ABORTED"
  | "BROWSER_OBSERVABILITY_FAILED"
  | "BROWSER_OBSERVABILITY_CONFIG_INVALID";

export class BrowserError extends Error {
  readonly code: BrowserErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: BrowserErrorCode,
    message: string,
    details: Record<string, string> = {},
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrowserError";
    this.code = code;
    this.details = details;
  }
}

/** No usable browser executable found via explicit config or any auto strategy. */
export function browserNotFound(displayName: string, strategiesTried: readonly string[]): BrowserError {
  return new BrowserError(
    "BROWSER_EXECUTABLE_NOT_FOUND",
    `${displayName} executable not found. Install ${displayName} or set an explicit path via the ARC_MCP_EXECUTABLE_PATH environment variable (executablePath).`,
    { strategiesTried: strategiesTried.join(",") },
  );
}

/** An explicit executable path was supplied but is not a usable executable. */
export function invalidExecutablePath(displayName: string, path: string, reason: string): BrowserError {
  return new BrowserError(
    "BROWSER_EXECUTABLE_PATH_INVALID",
    `Configured ${displayName} executable path is invalid: ${reason}. Fix ARC_MCP_EXECUTABLE_PATH (executablePath) or unset it to use auto-discovery.`,
    { path },
  );
}

/** A profile path target is unsafe for the dedicated MCP profile. */
export function unsafeProfilePath(path: string, reason: string): BrowserError {
  return new BrowserError(
    "BROWSER_PROFILE_PATH_UNSAFE",
    `Refusing to use unsafe MCP profile path: ${reason}. Choose a project-owned directory outside browser install/package data (default: ${path}).`,
    { path },
  );
}

/** Spawning the dedicated browser process failed. */
export function launchFailed(reason: string, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_LAUNCH_FAILED",
    `Failed to launch dedicated browser instance: ${reason}.`,
    {},
    cause === undefined ? {} : { cause },
  );
}

/** The configured CDP port is already occupied; refusing to attach or kill. */
export function cdpPortInUse(port: number): BrowserError {
  return new BrowserError(
    "BROWSER_CDP_PORT_IN_USE",
    `CDP port ${String(port)} on 127.0.0.1 is already occupied. arc-mcp will not attach to or kill whatever owns it. Choose a free ARC_MCP_DEBUG_PORT.`,
    { port: String(port) },
  );
}

/** The owned browser process exited before CDP became ready. */
export function processExitedEarly(port: number, exitInfo: string): BrowserError {
  return new BrowserError(
    "BROWSER_PROCESS_EXITED_EARLY",
    `Dedicated browser process exited before CDP became ready on port ${String(port)} (${exitInfo}).`,
    { port: String(port), exitInfo },
  );
}

/** CDP readiness probe timed out without usable /json/version metadata. */
export function cdpReadyTimeout(port: number, timeoutMs: number, lastError: string): BrowserError {
  return new BrowserError(
    "BROWSER_CDP_READY_TIMEOUT",
    `Timed out after ${String(timeoutMs)}ms waiting for CDP on 127.0.0.1:${String(port)}. Last probe error: ${lastError}`,
    { port: String(port), timeoutMs: String(timeoutMs), lastError },
  );
}

/** Playwright could not attach to a ready CDP endpoint. */
export function cdpConnectFailed(endpoint: string, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_CDP_CONNECT_FAILED",
    `Playwright failed to connect over CDP to ${endpoint}.`,
    { endpoint },
    cause === undefined ? {} : { cause },
  );
}

/** Connected browser exposes no usable default context. */
export function cdpNoContext(): BrowserError {
  return new BrowserError(
    "BROWSER_CDP_NO_CONTEXT",
    "Connected browser exposes no usable default browser context; refusing to continue without one.",
  );
}

/** A BrowserEngine operation with no backend implementation was invoked. */
export function browserOperationNotImplemented(operation: string): BrowserError {
  return new BrowserError(
    "BROWSER_OPERATION_NOT_IMPLEMENTED",
    `Browser operation '${operation}' is not implemented by this backend.`,
    { operation },
  );
}

/** A project tab ID is unknown, malformed, or refers to a closed tab. */
export function browserTabNotFound(tabId: string): BrowserError {
  return new BrowserError(
    "BROWSER_TAB_NOT_FOUND",
    `No open tab matches ${JSON.stringify(tabId)}; it may be closed or stale. List tabs again for current IDs.`,
    { tabId },
  );
}

/** Tab creation failed (invalid URL, backend rejection, or transport loss). */
export function browserTabCreateFailed(reason: string, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_TAB_CREATE_FAILED",
    `Could not open a tab: ${reason}.`,
    {},
    cause === undefined ? {} : { cause },
  );
}

/** Tab closure failed (backend rejection or transport loss mid-operation). */
export function browserTabCloseFailed(tabId: string, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_TAB_CLOSE_FAILED",
    `Could not close tab ${JSON.stringify(tabId)}.`,
    { tabId },
    cause === undefined ? {} : { cause },
  );
}

/** A navigation/history/reload command needs a logically selected tab. */
export function browserNoSelectedTab(operation: string): BrowserError {
  return new BrowserError(
    "BROWSER_NO_SELECTED_TAB",
    `Cannot ${operation}: no tab is selected. Select or open a tab first.`,
    { operation },
  );
}

/** A navigation destination failed URL policy validation. */
export function browserUrlNotAllowed(url: string, reason: string): BrowserError {
  return new BrowserError(
    "BROWSER_URL_NOT_ALLOWED",
    `Refusing to navigate to ${JSON.stringify(url)}: ${reason}.`,
    { url, reason },
  );
}

/** The selected tab is a privileged/internal page navigation must not touch. */
export function browserTabNotControllable(tabId: string, url: string): BrowserError {
  return new BrowserError(
    "BROWSER_TAB_NOT_CONTROLLABLE",
    `Tab ${JSON.stringify(tabId)} is not a controllable web page (current URL scheme cannot be navigated by the agent).`,
    { tabId, url },
  );
}

/** No history entry exists in the requested direction. */
export function browserHistoryUnavailable(direction: "back" | "forward", tabId: string): BrowserError {
  return new BrowserError(
    "BROWSER_HISTORY_UNAVAILABLE",
    `No ${direction} history is available for tab ${JSON.stringify(tabId)}.`,
    { direction, tabId },
  );
}

/** The browser accepted validation but rejected the navigation command. */
export function browserNavigationFailed(operation: string, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_NAVIGATION_FAILED",
    `The browser rejected the ${operation} command.`,
    { operation },
    cause === undefined ? {} : { cause },
  );
}

/** Snapshot capture failed after selection/controllability were established. */
export function browserSnapshotFailed(reason: string, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_SNAPSHOT_FAILED",
    `Could not capture a snapshot of the selected tab: ${reason}.`,
    { reason },
    cause === undefined ? {} : { cause },
  );
}

/** Another debugger owns the tab; arc-mcp must not steal or replace it. */
export function browserDebuggerUnavailable(tabId: string, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_DEBUGGER_UNAVAILABLE",
    `Tab ${JSON.stringify(tabId)} already has a debugger attached (e.g. DevTools); refusing to steal it.`,
    { tabId },
    cause === undefined ? {} : { cause },
  );
}

/** An element ref is from an older snapshot/document and can never retarget. */
export function browserStaleElement(ref: string): BrowserError {
  return new BrowserError(
    "BROWSER_STALE_ELEMENT",
    `Element reference ${JSON.stringify(ref)} is stale; capture a fresh snapshot and use its refs.`,
    { ref },
  );
}

/** A live element cannot be clicked in its current state (never retargets). */
export function browserElementNotInteractable(reason: string): BrowserError {
  return new BrowserError("BROWSER_ELEMENT_NOT_INTERACTABLE", `Element is not interactable: ${reason}.`, { reason });
}

/** A live element is not an editable text control. */
export function browserElementNotEditable(reason: string): BrowserError {
  return new BrowserError("BROWSER_ELEMENT_NOT_EDITABLE", `Element is not editable: ${reason}.`, { reason });
}

/** A pressKey key/chord is outside the supported allowlist. */
export function browserInvalidKey(key: string): BrowserError {
  return new BrowserError(
    "BROWSER_INVALID_KEY",
    `Unsupported key ${JSON.stringify(key)}; use Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space, letters, digits, F1-F12, optionally with Control/Shift/Alt/Meta.`,
    {},
  );
}

/** Fill/type text exceeds the documented hard byte limit. */
export function browserInvalidText(byteLength: number, limitBytes: number): BrowserError {
  return new BrowserError(
    "BROWSER_INVALID_TEXT",
    `Text is too large (${String(byteLength)} UTF-8 bytes; limit ${String(limitBytes)}). Split the input across operations.`,
    { byteLength: String(byteLength), limitBytes: String(limitBytes) },
  );
}

/** A validated interaction was rejected or lost by the browser. */
export function browserInteractionFailed(operation: string, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_INTERACTION_FAILED",
    `The browser rejected the ${operation} command.`,
    { operation },
    cause === undefined ? {} : { cause },
  );
}

/** Page JavaScript evaluation failed (generic; never echoes the expression). */
export function browserEvaluationFailed(cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_EVALUATION_FAILED",
    "Page evaluation failed.",
    {},
    cause === undefined ? {} : { cause },
  );
}

/** Page JavaScript evaluation exceeded its bounded deadline. */
export function browserEvaluationTimeout(timeoutMs: number, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_EVALUATION_TIMEOUT",
    `Page evaluation timed out after ${String(timeoutMs)}ms.`,
    { timeoutMs: String(timeoutMs) },
    cause === undefined ? {} : { cause },
  );
}

/** The serialized public evaluation result exceeded the hard cap. */
export function browserEvaluationResultTooLarge(byteLength: number, limitBytes: number, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_EVALUATION_RESULT_TOO_LARGE",
    `Evaluation result is too large (${String(byteLength)} bytes; limit ${String(limitBytes)}). Narrow the expression.`,
    { byteLength: String(byteLength), limitBytes: String(limitBytes) },
    cause === undefined ? {} : { cause },
  );
}

/** Viewport screenshot capture failed. */
export function browserScreenshotFailed(reason: string, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_SCREENSHOT_FAILED",
    `Could not capture a screenshot of the selected tab: ${reason}.`,
    { reason },
    cause === undefined ? {} : { cause },
  );
}

/** The decoded screenshot exceeded the hard PNG byte cap. */
export function browserScreenshotTooLarge(byteLength: number, limitBytes: number, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_SCREENSHOT_TOO_LARGE",
    `Screenshot is too large (${String(byteLength)} bytes; limit ${String(limitBytes)}).`,
    { byteLength: String(byteLength), limitBytes: String(limitBytes) },
    cause === undefined ? {} : { cause },
  );
}

/** A bounded wait condition was not satisfied before its deadline. */
export function browserWaitTimeout(condition: string, timeoutMs: number, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_WAIT_TIMEOUT",
    `Timed out after ${String(timeoutMs)}ms waiting for ${condition}.`,
    { condition, timeoutMs: String(timeoutMs) },
    cause === undefined ? {} : { cause },
  );
}

/** A wait aborted because the logical selection changed or the tab went away. */
export function browserWaitAborted(reason: string, cause?: unknown): BrowserError {
  return new BrowserError(
    "BROWSER_WAIT_ABORTED",
    `The wait aborted: ${reason}.`,
    { reason },
    cause === undefined ? {} : { cause },
  );
}

/** Observability get/clear rejected by the extension or transport. */
export function browserObservabilityFailed(operation: string, remoteCode: string | null, cause?: unknown): BrowserError {
  const suffix = remoteCode === null ? "rejected by the extension" : `rejected by the extension (${remoteCode})`;
  return new BrowserError(
    "BROWSER_OBSERVABILITY_FAILED",
    `Could not ${operation} observability data: ${suffix}.`,
    { operation },
    cause === undefined ? {} : { cause },
  );
}

/** Observability buffer configuration is invalid (deterministic, pre-dispatch). */
export function browserObservabilityConfigInvalid(name: string, reason: string): BrowserError {
  return new BrowserError(
    "BROWSER_OBSERVABILITY_CONFIG_INVALID",
    `Invalid observability buffer configuration for ${name}: ${reason}.`,
    { name, reason },
  );
}
