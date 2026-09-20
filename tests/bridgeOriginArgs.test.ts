import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import { parseNativeHostArgs, safeEqualString } from "../src/bridge/nativeHostArgs.js";

const EXPECTED = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";

describe("native host caller validation", () => {
  it("accepts the exact expected origin with parent-window present", () => {
    const parsed = parseNativeHostArgs([EXPECTED, "--parent-window=123456"], EXPECTED);
    expect(parsed.origin).toBe(EXPECTED);
    expect(parsed.parentWindow).toBe("123456");
  });

  it("accepts origin regardless of argument order", () => {
    const parsed = parseNativeHostArgs(["--parent-window=99", EXPECTED], EXPECTED);
    expect(parsed.origin).toBe(EXPECTED);
  });

  it("rejects a wrong extension origin", () => {
    expect(() =>
      parseNativeHostArgs(["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/", "--parent-window=1"], EXPECTED),
    ).toThrow(BridgeError);
    try {
      parseNativeHostArgs(["chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"], EXPECTED);
    } catch (error: unknown) {
      expect((error as BridgeError).code).toBe("ORIGIN_REJECTED");
    }
  });

  it("rejects a missing origin", () => {
    expect(() => parseNativeHostArgs(["--parent-window=1"], EXPECTED)).toThrow(BridgeError);
    expect(() => parseNativeHostArgs([], EXPECTED)).toThrow(BridgeError);
  });

  it("rejects unrelated arguments instead of ignoring them", () => {
    expect(() => parseNativeHostArgs([EXPECTED, "--do-evil-thing"], EXPECTED)).toThrow(BridgeError);
  });

  it("rejects multiple distinct origins", () => {
    expect(() =>
      parseNativeHostArgs([EXPECTED, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"], EXPECTED),
    ).toThrow(BridgeError);
  });
});

describe("safeEqualString", () => {
  it("compares exactly and tolerates length mismatch", () => {
    expect(safeEqualString("abc", "abc")).toBe(true);
    expect(safeEqualString("abc", "abd")).toBe(false);
    expect(safeEqualString("abc", "abcd")).toBe(false);
    expect(safeEqualString("", "")).toBe(true);
  });
});
