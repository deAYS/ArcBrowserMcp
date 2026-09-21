import { BridgeError } from "./BridgeError.js";
import "./frameLimits.js";

/**
 * Versioned bridge RPC envelopes shared by all three sides (MCP process,
 * native host, extension). This module is dependency-free on purpose: the
 * extension bundle imports it, so no Node APIs may appear here.
 *
 * Frame bounds live in frameLimits.ts (imported by both the extension-safe
 * policy modules and this envelope module). Direction map (each framed
 * reader/writer is classified at its call site):
 * - Node/server -> native host request .... SMALL (mcpPipeServer encoder)
 * - native host -> extension request ...... SMALL (host forwardToNative)
 * - extension -> native host response .... LARGE (host stdinDecoder; 64 MiB platform cap)
 * - native host -> Node/server response .. LARGE (host forwardToPipe encoder, pipe-server decoder)
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

export { LARGE_RESPONSE_FRAME_MAX_BYTES, SMALL_FRAME_MAX_BYTES } from "./frameLimits.js";
export { MAX_BRIDGE_MESSAGE_BYTES } from "./frameLimits.js";

export type BridgeMessageType = "request" | "response" | "event";

export type BridgeMethod = "bridge.hello" | "bridge.ping" | "bridge.status";

export interface BridgeRequest {
  readonly version: 1;
  readonly id: string;
  readonly type: "request";
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

export interface BridgeResponseOk {
  readonly version: 1;
  readonly id: string;
  readonly type: "response";
  readonly ok: true;
  readonly payload: Record<string, unknown>;
}

export interface BridgeResponseError {
  readonly version: 1;
  readonly id: string;
  readonly type: "response";
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    /** Optional bounded metadata (e.g. remoteCode) preserved across proxy hops. */
    readonly details?: Readonly<Record<string, string>>;
  };
}

export type BridgeResponse = BridgeResponseOk | BridgeResponseError;

export interface BridgeEvent {
  readonly version: 1;
  readonly id: string;
  readonly type: "event";
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

export type BridgeMessage = BridgeRequest | BridgeResponse | BridgeEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asPayload(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/**
 * Validate an unknown decoded value as a bridge envelope.
 * Unknown protocol versions and malformed shapes throw typed errors;
 * no message is ever trusted without this gate.
 */
export function parseBridgeMessage(value: unknown): BridgeMessage {
  if (!isRecord(value)) {
    throw new BridgeError("INVALID_ENVELOPE", "bridge message must be a JSON object");
  }
  if (value["version"] !== BRIDGE_PROTOCOL_VERSION) {
    throw new BridgeError(
      "UNSUPPORTED_VERSION",
      `unsupported bridge protocol version ${JSON.stringify(value["version"])}; expected ${String(BRIDGE_PROTOCOL_VERSION)}`,
    );
  }
  const id = nonEmptyString(value["id"]);
  if (id === null) {
    throw new BridgeError("INVALID_ENVELOPE", "bridge message id must be a non-empty string");
  }
  const type = value["type"];
  if (type === "request" || type === "event") {
    const method = nonEmptyString(value["method"]);
    if (method === null) {
      throw new BridgeError("INVALID_ENVELOPE", `bridge ${type} method must be a non-empty string`);
    }
    const payload = asPayload(value["payload"]);
    if (payload === null) {
      throw new BridgeError("INVALID_ENVELOPE", `bridge ${type} payload must be an object`);
    }
    return type === "request"
      ? { version: 1, id, type, method, payload }
      : { version: 1, id, type, method, payload };
  }
  if (type === "response") {
    if (value["ok"] === true) {
      const payload = asPayload(value["payload"]);
      if (payload === null) {
        throw new BridgeError("INVALID_ENVELOPE", "bridge ok-response payload must be an object");
      }
      return { version: 1, id, type, ok: true, payload };
    }
    if (value["ok"] === false) {
      const error = value["error"];
      if (!isRecord(error) || typeof error["code"] !== "string" || typeof error["message"] !== "string") {
        throw new BridgeError("INVALID_ENVELOPE", "bridge error-response needs {code, message} strings");
      }
      let details: Record<string, string> | undefined;
      if (error["details"] !== undefined) {
        const raw = error["details"];
        if (!isRecord(raw)) {
          throw new BridgeError("INVALID_ENVELOPE", "bridge error-response details must be an object");
        }
        details = {};
        for (const [key, entry] of Object.entries(raw)) {
          if (typeof entry !== "string") {
            throw new BridgeError("INVALID_ENVELOPE", "bridge error-response details must hold string values");
          }
          details[key] = entry;
        }
      }
      return details === undefined
        ? { version: 1, id, type, ok: false, error: { code: error["code"], message: error["message"] } }
        : { version: 1, id, type, ok: false, error: { code: error["code"], message: error["message"], details } };
    }
    throw new BridgeError("INVALID_ENVELOPE", "bridge response ok must be boolean true/false");
  }
  throw new BridgeError(
    "INVALID_ENVELOPE",
    `bridge message type must be request/response/event, got ${JSON.stringify(type)}`,
  );
}

export function errorResponse(
  id: string,
  code: string,
  message: string,
  details?: Readonly<Record<string, string>>,
): BridgeResponseError {
  return details === undefined || Object.keys(details).length === 0
    ? { version: 1, id, type: "response", ok: false, error: { code, message } }
    : { version: 1, id, type: "response", ok: false, error: { code, message, details } };
}
