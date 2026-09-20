import { BridgeError } from "./BridgeError.js";
import { LARGE_RESPONSE_FRAME_MAX_BYTES, SMALL_FRAME_MAX_BYTES } from "./protocol.js";

/**
 * Native Messaging framing: UTF-8 JSON prefixed by a 32-bit native-endian
 * byte length. Used on Chrome stdio and reused for the named-pipe channel
 * so one tested codec covers both transports.
 *
 * Stream-safe: never assumes one read equals one message. All bounds are
 * enforced before allocation-heavy work.
 *
 * Directional bounds: the same codec serves two payload classes, so
 * both the encoder and the decoder take an explicit direction role:
 * - "small": every request/command path plus all host->extension traffic
 *   (256 KiB). This is the default; passing no role can only ever produce
 *   the tight bound, never the large one.
 * - "large-response": extension-originated responses only (16 MiB), i.e.
 *   the screenshot-carrying direction. Callers must justify this role at
 *   each use site; it must never guard the host->extension request path
 *   (1 MiB Chrome platform ceiling).
 */

export const NATIVE_FRAME_HEADER_BYTES = 4;

export type FrameDirection = "small" | "large-response";

function maxFor(direction: FrameDirection): number {
  return direction === "large-response" ? LARGE_RESPONSE_FRAME_MAX_BYTES : SMALL_FRAME_MAX_BYTES;
}

export function encodeNativeMessage(value: unknown, direction: FrameDirection = "small"): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf-8");
  const limit = maxFor(direction);
  if (body.length > limit) {
    throw new BridgeError(
      "NATIVE_FRAME_TOO_LARGE",
      `native message is ${String(body.length)} bytes; limit is ${String(limit)}`,
      { bytes: String(body.length) },
    );
  }
  const header = Buffer.alloc(NATIVE_FRAME_HEADER_BYTES);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class NativeFrameDecoder {
  private pending = Buffer.alloc(0);

  constructor(private readonly direction: FrameDirection = "small") {}

  private get limit(): number {
    return maxFor(this.direction);
  }

  /**
   * Feed raw bytes; returns every complete decoded JSON value in order.
   * Throws typed errors on oversized frames or malformed JSON; the decoder
   * resets to a clean state after a malformed frame so one bad frame cannot
   * poison the stream. Call end() at EOF to surface truncated frames.
   */
  push(chunk: Buffer): unknown[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      if (this.pending.length < NATIVE_FRAME_HEADER_BYTES) {
        return messages;
      }
      // readUInt32LE interprets the prefix as an unsigned 32-bit length, so
      // high-bit / "negative" representations arrive as large positives and
      // are rejected against the directional maximum below like any other
      // oversized declaration. No signed interpretation, no wraparound.
      const length = this.pending.readUInt32LE(0);
      const limit = this.limit;
      // Length-prefix validation happens BEFORE any body allocation or read:
      // the pending buffer is reset to a clean state so one absurd prefix
      // cannot poison the stream or pin memory. Only bounded metadata
      // (declared/maximum bytes) travels with the typed error; never the
      // body, which has not even been read yet.
      if (length === 0 || length > limit) {
        const declared = length;
        this.pending = Buffer.alloc(0);
        throw new BridgeError(
          "NATIVE_FRAME_TOO_LARGE",
          `native frame declares ${String(declared)} bytes; limit is ${String(limit)}`,
          { bytes: String(declared) },
        );
      }
      if (this.pending.length < NATIVE_FRAME_HEADER_BYTES + length) {
        return messages;
      }
      const body = this.pending.subarray(NATIVE_FRAME_HEADER_BYTES, NATIVE_FRAME_HEADER_BYTES + length);
      this.pending = this.pending.subarray(NATIVE_FRAME_HEADER_BYTES + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf-8")) as unknown;
      } catch (error: unknown) {
        throw new BridgeError("NATIVE_FRAME_MALFORMED", "native frame body is not valid JSON", {}, error);
      }
      messages.push(parsed);
    }
  }

  /** Signal EOF; throws when a truncated frame remains. */
  end(): void {
    if (this.pending.length > 0) {
      const remaining = this.pending.length;
      this.pending = Buffer.alloc(0);
      throw new BridgeError(
        "NATIVE_FRAME_INCOMPLETE",
        `stdin ended with ${String(remaining)} unframed bytes pending`,
        { bytes: String(remaining) },
      );
    }
  }
}
