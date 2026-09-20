/**
 * Typed bridge errors (P03B transport scope only).
 *
 * Stable machine-readable codes so both ends and tests discriminate without
 * string matching. Original failures travel through `cause` where useful.
 */

export type BridgeErrorCode =
  | "INVALID_ENVELOPE"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_METHOD"
  | "NOT_AUTHENTICATED"
  | "NOT_CONNECTED"
  | "TIMEOUT"
  | "PIPE_BUSY"
  | "SESSION_MISSING"
  | "SESSION_STALE"
  | "SESSION_CORRUPT"
  | "ORIGIN_REJECTED"
  | "NATIVE_FRAME_TOO_LARGE"
  | "NATIVE_FRAME_MALFORMED"
  | "NATIVE_FRAME_INCOMPLETE"
  | "REGISTRY_ERROR"
  | "HOST_STARTUP_FAILED"
  | "EXTENSION_CONNECT_TIMEOUT"
  | "BRIDGE_PREFLIGHT_FAILED";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: BridgeErrorCode, message: string, details: Record<string, string> = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}
