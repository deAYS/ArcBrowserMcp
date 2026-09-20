import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import { encodeNativeMessage, NativeFrameDecoder } from "../src/bridge/nativeFraming.js";

function split(buffer: Buffer, at: number): [Buffer, Buffer] {
  return [buffer.subarray(0, at), buffer.subarray(at)];
}

describe("native framing codec", () => {
  it("round-trips a message with exact byte length", () => {
    const encoded = encodeNativeMessage({ type: "request", id: "é✓" });
    expect(encoded.readUInt32LE(0)).toBe(encoded.length - 4);
    const decoder = new NativeFrameDecoder();
    const [first, rest] = split(encoded, 2);
    expect(decoder.push(first)).toEqual([]);
    expect(decoder.push(rest)).toEqual([{ type: "request", id: "é✓" }]);
  });

  it("handles split bodies and multiple frames in one read", () => {
    const a = encodeNativeMessage({ n: 1 });
    const b = encodeNativeMessage({ n: 2 });
    const combined = Buffer.concat([a, b]);
    const decoder = new NativeFrameDecoder();
    // Split inside the second body.
    const [first, rest] = split(combined, a.length + 3);
    expect(decoder.push(first)).toEqual([{ n: 1 }]);
    expect(decoder.push(rest)).toEqual([{ n: 2 }]);
  });

  it("counts UTF-8 multibyte characters in bytes, not chars", () => {
    const value = { text: "héllo wörld ✓✓✓" };
    const encoded = encodeNativeMessage(value);
    expect(encoded.readUInt32LE(0)).toBe(Buffer.byteLength(JSON.stringify(value), "utf-8"));
    expect(new NativeFrameDecoder().push(encoded)).toEqual([value]);
  });

  it("rejects malformed JSON with a typed error and recovers", () => {
    const body = Buffer.from("{not json", "utf-8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    const decoder = new NativeFrameDecoder();
    let caught: unknown = null;
    try {
      decoder.push(Buffer.concat([header, body]));
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe("NATIVE_FRAME_MALFORMED");
    // Decoder reset: a subsequent good frame still decodes.
    expect(decoder.push(encodeNativeMessage({ ok: true }))).toEqual([{ ok: true }]);
  });

  it("rejects oversized frames before allocating the body", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(256 * 1024 + 1, 0);
    const decoder = new NativeFrameDecoder();
    let caught: unknown = null;
    try {
      decoder.push(header);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe("NATIVE_FRAME_TOO_LARGE");
  });

  it("rejects oversized encoding", () => {
    expect(() => encodeNativeMessage({ blob: "x".repeat(300 * 1024) })).toThrow(BridgeError);
  });

  it("reports EOF during header and during body", () => {
    const headerOnly = new NativeFrameDecoder();
    expect(() => {
      headerOnly.push(Buffer.from([0x05, 0x00]));
      headerOnly.end();
    }).toThrow(BridgeError);
    const bodyPartial = new NativeFrameDecoder();
    const full = encodeNativeMessage({ n: 1 });
    const [part] = split(full, full.length - 2);
    expect(bodyPartial.push(part)).toEqual([]);
    let caught: unknown = null;
    try {
      bodyPartial.end();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe("NATIVE_FRAME_INCOMPLETE");
  });

  it("accepts clean EOF with nothing pending", () => {
    expect(() => new NativeFrameDecoder().end()).not.toThrow();
  });
});
