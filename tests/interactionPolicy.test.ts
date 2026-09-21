import { describe, expect, it } from "vitest";
import {
  HUMANIZE_WPM_DEFAULT,
  INTERACTION_TEXT_LIMIT_BYTES,
  chunkTextForHumanize,
  humanizeChunkDelayMs,
  isSupportedPressKey,
  normalizeSequenceDelayMs,
  normalizeWpm,
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
    expect(isSupportedPressKey("Shift")).toBe(false);
  });

  it("accepts letters, digits, function keys, and shortcuts for sequences", () => {
    for (const key of ["a", "A", "z", "0", "9", "F1", "F12", ";", ".", "Control+a", "Control+Shift+Enter"]) {
      expect(isSupportedPressKey(key), key).toBe(true);
    }
    const chord = parsePressKey("Control+a");
    expect("error" in chord).toBe(false);
    if (!("error" in chord)) {
      expect(chord.code).toBe("KeyA");
      expect(chord.windowsVirtualKeyCode).toBe(65);
      expect(chord.control).toBe(true);
    }
    expect(isSupportedPressKey("Control+Control+a")).toBe(false);
  });

  it("normalizes humanize pacing inputs and chunks text deterministically", () => {
    expect(normalizeWpm(undefined)).toBe(HUMANIZE_WPM_DEFAULT);
    expect(normalizeWpm(80)).toBe(80);
    expect(normalizeWpm(19)).toBeNull();
    expect(normalizeWpm(201)).toBeNull();
    expect(normalizeSequenceDelayMs(undefined)).toBe(60);
    expect(normalizeSequenceDelayMs(0)).toBe(0);
    expect(normalizeSequenceDelayMs(2001)).toBeNull();
    expect(chunkTextForHumanize("abcdefgh", 4)).toEqual(["abcd", "efgh"]);
    const first = humanizeChunkDelayMs(80, 0, "abcd");
    const second = humanizeChunkDelayMs(80, 1, "efgh");
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(humanizeChunkDelayMs(80, 0, "abcd")).toBe(first);
    expect(humanizeChunkDelayMs(10, 0, "abcd")).toBe(humanizeChunkDelayMs(HUMANIZE_WPM_DEFAULT, 0, "abcd"));
  });
});
