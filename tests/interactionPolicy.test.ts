import { describe, expect, it } from "vitest";
import {
  HUMANIZE_WPM_DEFAULT,
  HUMAN_KEYS_MODE_MAX_CHARS,
  INTERACTION_TEXT_LIMIT_BYTES,
  MOUSE_MAX_TOTAL_MS,
  chunkTextForHumanize,
  gauss01,
  hoverDwellMs,
  humanizeChunkDelayMs,
  isSupportedPressKey,
  jitterClickPoint,
  normalizeHumanTypeMode,
  normalizeSequenceDelayMs,
  normalizeWpm,
  parsePressKey,
  planInsertChunks,
  planKeystrokes,
  planMouseMove,
  pressHoldMs,
  sampleLognormal,
  utf8ByteLength,
  wpmToMedianIkiMs,
} from "../src/browser/interactionPolicy.js";

/** Deterministic stub RNG (mulberry32-style LCG) for distribution tests. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

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
    for (const key of ["a", "A", "z", "0", "9", "F1", "F12", ";", ".", ":", "!", "?", '"', "(", ")", "Control+a", "Control+Shift+Enter"]) {
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

  it("normalizes the human typing mode with keys as default", () => {
    expect(normalizeHumanTypeMode(undefined)).toBe("keys");
    expect(normalizeHumanTypeMode("keys")).toBe("keys");
    expect(normalizeHumanTypeMode("insert")).toBe("insert");
    expect(normalizeHumanTypeMode("rapid")).toBe("rapid");
    expect(normalizeHumanTypeMode("fast")).toBeNull();
    expect(normalizeHumanTypeMode(42)).toBeNull();
    expect(HUMAN_KEYS_MODE_MAX_CHARS).toBe(1500);
  });

  it("samples lognormal timing within bounds and honors the median", () => {
    const rng = seededRng(7);
    const samples = Array.from({ length: 200 }, () => sampleLognormal(150, 0.45, 60, 2000, rng));
    expect(samples.every((value) => value >= 60 && value <= 2000)).toBe(true);
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    // Lognormal mean exceeds the median; both stay in a human band.
    expect(mean).toBeGreaterThan(140);
    expect(mean).toBeLessThan(260);
    // Deterministic under a seeded RNG.
    const replayRng = seededRng(7);
    const replay = Array.from({ length: 200 }, () => sampleLognormal(150, 0.45, 60, 2000, replayRng));
    expect(replay).toEqual(samples);
    expect(gauss01(seededRng(1))).not.toBe(gauss01(seededRng(2)));
  });

  it("plans keystrokes with floors, digraph speedups, and intact emoji", () => {
    const rng = seededRng(11);
    const plan = planKeystrokes("the 🙂\nOk.", 80, rng);
    expect(plan.map((entry) => entry.char).join("")).toBe("the 🙂\nOk.");
    // Emoji survives as one code-point entry.
    expect(plan.filter((entry) => entry.char === "🙂")).toHaveLength(1);
    for (const entry of plan) {
      expect(entry.flightMs).toBeGreaterThanOrEqual(0);
      expect(entry.dwellMs).toBeGreaterThanOrEqual(40);
      expect(entry.dwellMs).toBeLessThanOrEqual(180);
    }
    // Common digraphs ("th", "he") run faster than rare pairs on average.
    const fast: number[] = [];
    const slow: number[] = [];
    for (let trial = 0; trial < 60; trial += 1) {
      const fastPlan = planKeystrokes("the", 80, seededRng(1000 + trial));
      const slowPlan = planKeystrokes("xqz", 80, seededRng(1000 + trial));
      fast.push(fastPlan[1]?.flightMs ?? 0, fastPlan[2]?.flightMs ?? 0);
      slow.push(slowPlan[1]?.flightMs ?? 0, slowPlan[2]?.flightMs ?? 0);
    }
    const average = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
    expect(average(fast)).toBeLessThan(average(slow));
    // Sentence punctuation adds a pause after the sentence, not mid-word.
    const punctuated = planKeystrokes("Hi. Ok", 80, seededRng(5));
    const afterPeriod = punctuated[3]?.flightMs ?? 0;
    const midWord = punctuated[1]?.flightMs ?? 0;
    expect(afterPeriod).toBeGreaterThan(midWord);
    expect(wpmToMedianIkiMs(80)).toBe(150);
    expect(wpmToMedianIkiMs(999)).toBe(wpmToMedianIkiMs(HUMANIZE_WPM_DEFAULT));
  });

  it("groups inserts that preserve text with bounded delays", () => {
    const chunks = planInsertChunks("hello world", 80, seededRng(3));
    expect(chunks.map((chunk) => chunk.text).join("")).toBe("hello world");
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(1);
      expect(chunk.text.length).toBeLessThanOrEqual(4);
      expect(chunk.delayMs).toBeGreaterThanOrEqual(0);
      expect(chunk.delayMs).toBeLessThanOrEqual(4000);
    }
    expect(chunks.at(-1)?.delayMs).toBe(0);
    expect(planInsertChunks("", 80, seededRng(3))).toEqual([]);
  });

  it("plans mouse moves that land exactly with bounded duration", () => {
    const from = { x: 100, y: 200 };
    const to = { x: 600, y: 500 };
    const plan = planMouseMove(from, to, 100, seededRng(21));
    expect(plan.points.length).toBeGreaterThan(8);
    expect(plan.points.length).toBeLessThanOrEqual(400);
    const last = plan.points.at(-1);
    expect(last?.x).toBe(to.x);
    expect(last?.y).toBe(to.y);
    expect(plan.durationMs).toBeLessThanOrEqual(MOUSE_MAX_TOTAL_MS);
    // Deterministic under a seeded RNG; resampled otherwise.
    const replay = planMouseMove(from, to, 100, seededRng(21));
    expect(replay).toEqual(plan);
    const other = planMouseMove(from, to, 100, seededRng(22));
    expect(other).not.toEqual(plan);
    // Short hops collapse to a single waypoint.
    const hop = planMouseMove(to, { x: to.x + 1, y: to.y }, 10, seededRng(1));
    expect(hop.points).toHaveLength(1);
    expect(hop.durationMs).toBe(0);
  });

  it("jitters click points inside the box with sane dwell/hold ranges", () => {
    const box = { minX: 0, minY: 0, maxX: 100, maxY: 20 };
    for (let trial = 0; trial < 50; trial += 1) {
      const point = jitterClickPoint(box, seededRng(trial));
      expect(point.x).toBeGreaterThanOrEqual(box.minX);
      expect(point.x).toBeLessThanOrEqual(box.maxX);
      expect(point.y).toBeGreaterThanOrEqual(box.minY);
      expect(point.y).toBeLessThanOrEqual(box.maxY);
    }
    // Not pinned to the exact center.
    const xs = new Set(Array.from({ length: 20 }, (_, trial) => jitterClickPoint(box, seededRng(trial)).x));
    expect(xs.size).toBeGreaterThan(1);
    for (let trial = 0; trial < 50; trial += 1) {
      const dwell = hoverDwellMs(seededRng(900 + trial));
      const hold = pressHoldMs(seededRng(1900 + trial));
      expect(dwell).toBeGreaterThanOrEqual(40);
      expect(dwell).toBeLessThanOrEqual(500);
      expect(hold).toBeGreaterThanOrEqual(30);
      expect(hold).toBeLessThanOrEqual(300);
    }
  });
});
