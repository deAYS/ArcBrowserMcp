import { describe, expect, it } from "vitest";
import {
  INTERACTION_TEXT_LIMIT_BYTES,
  isSupportedPressKey,
  parsePressKey,
  utf8ByteLength,
} from "../src/browser/interactionPolicy.js";

describe("interaction policy", () => {
  it("measures UTF-8 bytes (ASCII, CJK, emoji, surrogate halves)", () => {
    expect(utf8ByteLength("hello")).toBe(5);
    expect(utf8ByteLength("世界")).toBe(6);
    expect(utf8ByteLength("🙂")).toBe(4);
    expect(utf8ByteLength("\ud800")).toBe(3);
    expect(INTERACTION_TEXT_LIMIT_BYTES).toBe(32 * 1024);
  });

  it("accepts the documented key set and canonicalizes Space", () => {
    for (const key of [
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      " ",
      "Space",
    ]) {
      expect(isSupportedPressKey(key), key).toBe(true);
    }
    const space = parsePressKey("Space");
    expect("error" in space).toBe(false);
    if (!("error" in space)) {
      expect(space.key).toBe(" ");
      expect(space.code).toBe("Space");
    }
  });

  it("accepts explicit modifiers and rejects unknown/duplicate/empty parts", () => {
    expect(isSupportedPressKey("Control+Enter")).toBe(true);
    expect(isSupportedPressKey("ctrl+shift+Tab")).toBe(true);
    expect(isSupportedPressKey("Alt+ArrowLeft")).toBe(true);
    expect(isSupportedPressKey("Meta+Enter")).toBe(true);
    expect(isSupportedPressKey("Control+Control+Enter")).toBe(false);
    expect(isSupportedPressKey("Super+Enter")).toBe(false);
    expect(isSupportedPressKey("Control+")).toBe(false);
    expect(isSupportedPressKey("+Enter")).toBe(false);
    expect(isSupportedPressKey("")).toBe(false);
    expect(isSupportedPressKey("a")).toBe(false);
    expect(isSupportedPressKey("F1")).toBe(false);
    expect(isSupportedPressKey("Shift")).toBe(false);
  });
});
