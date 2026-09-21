/**
 * Shared interaction policy (Node + extension, dependency-free).
 *
 * Owns the browser-neutral interaction boundaries so both sides enforce the
 * same contract without duplicating magic values:
 * - UTF-8 byte limit for fill/type text (hard cap, fail before any CDP).
 * - pressKey allowlist: supported keys + modifiers, with Windows-key-code
 *   mapping data the extension translates to CDP Input.dispatchKeyEvent.
 * - humanized composite defaults: WPM range, per-key delay range, sequence
 *   caps, and deterministic chunk/delay helpers so Node gates and the
 *   extension compute identical timing without extra RPC.
 * - neuromotor humanization generators (mouse trajectories, keystroke
 *   timing): extension-safe math with an injectable RNG. Production passes
 *   Math.random; tests inject a seeded stub for determinism. Uniform
 *   randomness is itself a bot tell, so every timing sample here is
 *   heavy-tailed (lognormal) and every trajectory carries structured
 *   human noise (Bezier arc + Fitts timing + overshoot + corrective
 *   submovements + hand tremor), matching published mouse/keystroke
 *   biometric research rather than naive jitter.
 * - redactedLength helper so length-gated errors never echo secret payload.
 */

export const INTERACTION_TEXT_LIMIT_BYTES = 32 * 1024;

/** UTF-8 byte length without Node APIs (extension-safe). */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export type PressKeyError = { readonly error: "BROWSER_INVALID_KEY" };

const SUPPORTED_KEYS: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  " ": "Space",
  Space: "Space",
  Spacebar: "Space",
};

const MODIFIER_ALIASES: Record<string, "Control" | "Shift" | "Alt" | "Meta"> = {
  Control: "Control",
  Ctrl: "Control",
  Shift: "Shift",
  Alt: "Alt",
  Meta: "Meta",
  Cmd: "Meta",
  Command: "Meta",
};

const VIRTUAL_KEY_CODES: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  Space: 32,
};

const FUNCTION_KEY_CODES: Record<string, number> = {
  F1: 112,
  F2: 113,
  F3: 114,
  F4: 115,
  F5: 116,
  F6: 117,
  F7: 118,
  F8: 119,
  F9: 120,
  F10: 121,
  F11: 122,
  F12: 123,
};

const PUNCTUATION_KEY_CODES: Record<string, { code: string; vk: number }> = {
  ";": { code: "Semicolon", vk: 186 },
  "=": { code: "Equal", vk: 187 },
  ",": { code: "Comma", vk: 188 },
  "-": { code: "Minus", vk: 189 },
  ".": { code: "Period", vk: 190 },
  "/": { code: "Slash", vk: 191 },
  "`": { code: "Backquote", vk: 192 },
  "[": { code: "BracketLeft", vk: 219 },
  "\\": { code: "Backslash", vk: 220 },
  "]": { code: "BracketRight", vk: 221 },
  "'": { code: "Quote", vk: 222 },
  // Shift-layer US punctuation: single-char keys go through CDP char
  // events (text is inserted verbatim), so the code only needs to be
  // plausible — insertion never depends on the OS layout.
  ":": { code: "Semicolon", vk: 186 },
  "!": { code: "Digit1", vk: 49 },
  "?": { code: "Slash", vk: 191 },
  '"': { code: "Quote", vk: 222 },
  "(": { code: "Digit9", vk: 57 },
  ")": { code: "Digit0", vk: 48 },
};

/** Humanized composite-action bounds (one tool call -> many CDP inputs). */
export const HUMANIZE_WPM_MIN = 20;
export const HUMANIZE_WPM_MAX = 200;
export const HUMANIZE_WPM_DEFAULT = 80;
export const HUMANIZE_SEQUENCE_DELAY_MIN_MS = 0;
export const HUMANIZE_SEQUENCE_DELAY_MAX_MS = 2000;
export const HUMANIZE_SEQUENCE_DELAY_DEFAULT_MS = 60;
export const PRESS_SEQUENCE_MAX_KEYS = 50;
export const TYPE_HUMAN_CHUNK_SIZE = 4;
export const CLICK_TYPE_SUBMIT_MAX_KEYS = 1;

// BEGIN HUMAN PROFILE (tuned by scripts/record-human/analyze.mjs --apply; do not hand-edit)
/**
 * Fitted human parameters. Defaults are literature values (136M-keystroke
 * IKI stats, Fitts-law mouse studies); analyze.mjs replaces them with
 * measurements from your own recordings. Shape: every timing sample is
 * lognormal(median, sigma) clamped to [floor, cap]; every trajectory is
 * Bezier + Fitts + overshoot + submovements + tremor (see planMouseMove).
 */
export const HUMAN_PROFILE = {
  /** Shannon Fitts intercept/slope for movement time (ms, ms/bit). */
  fittsAMs: 100,
  fittsBMs: 120,
  /** Lateral Bezier deviation as a fraction of distance (one-sided). */
  curveMinFraction: 0.06,
  curveMaxFraction: 0.3,
  /** Half-normal overshoot scale (px) applied past this distance (px). */
  overshootSigmaPx: 12,
  overshootMinDistPx: 250,
  /** Sinusoidal hand tremor: amplitude (px) and frequency band (Hz). */
  tremorAmpPx: 0.9,
  tremorFreqMinHz: 8,
  tremorFreqMaxHz: 12,
  /** Pre-click hover dwell (ms). */
  hoverMedianMs: 120,
  hoverSigma: 0.55,
  hoverFloorMs: 40,
  hoverCapMs: 500,
  /** Mouse-button hold time (ms). */
  holdMedianMs: 75,
  holdSigma: 0.5,
  holdFloorMs: 30,
  holdCapMs: 300,
  /** Inter-key flight time: shape + hard floor/cap (ms). Median comes from WPM. */
  ikiSigma: 0.45,
  ikiFloorMs: 60,
  ikiCapMs: 2000,
  /** Key hold (dwell) time (ms). */
  dwellMedianMs: 85,
  dwellSigma: 0.35,
  dwellFloorMs: 40,
  dwellCapMs: 180,
  /** Multiplier for frequent digraphs (0.72 = 28% faster). */
  digraphSpeedup: 0.72,
  /** Extra pause after space / sentence punctuation / newline (ms). */
  wordPauseMedianMs: 120,
  wordPauseSigma: 0.6,
  wordPauseCapMs: 800,
  sentencePauseMedianMs: 350,
  sentencePauseSigma: 0.7,
  sentencePauseFloorMs: 100,
  sentencePauseCapMs: 1500,
  newlinePauseMedianMs: 250,
  newlinePauseSigma: 0.6,
  newlinePauseFloorMs: 80,
  newlinePauseCapMs: 1000,
  /** Occasional thinking pause: probability per keystroke + shape (ms). */
  thinkingProb: 0.04,
  thinkingPauseMedianMs: 500,
  thinkingPauseSigma: 0.6,
  thinkingPauseFloorMs: 200,
  thinkingPauseCapMs: 1500,
  /** Click-point jitter as a fraction of the element half-size. */
  clickJitterFraction: 0.18,
  /** Measured natural typing rate; --apply also adopts it as WPM default. */
  naturalWpm: 80,
} as const;
// END HUMAN PROFILE

export interface ParsedKey {
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
  readonly modifiers: number;
  readonly control: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

/**
 * Parse a pressKey key expression. Accepted forms: "Enter", " ",
 * "Control+Shift+Enter" (case-insensitive for modifiers, exact canonical
 * key name otherwise), plus single letters/digits/punctuation ("a",
 * "A", "1", ";") and "F1".."F12" with optional modifiers
 * (e.g. "Control+a" for select-all). Returns the parsed spec or an
 * invalid marker; callers map the marker to BROWSER_INVALID_KEY before
 * any bridge traffic.
 */
export function parsePressKey(raw: string): ParsedKey | PressKeyError {
  if (typeof raw !== "string" || raw === "") {
    return { error: "BROWSER_INVALID_KEY" };
  }
  // Bare spacebar: the key IS a single space (trimming would erase it).
  if (raw === " ") {
    return {
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
      modifiers: 0,
      control: false,
      shift: false,
      alt: false,
      meta: false,
    };
  }
  const parts = raw.split("+").map((part) => part.trim());
  if (parts.some((part) => part === "")) {
    return { error: "BROWSER_INVALID_KEY" };
  }
  const keyName = parts[parts.length - 1] as string;
  const resolved = resolveKeyName(keyName);
  if (resolved === undefined) {
    return { error: "BROWSER_INVALID_KEY" };
  }
  const canonical = resolved.canonical;
  const modifiers = parts.slice(0, -1);
  let control = false;
  let shift = false;
  let alt = false;
  let meta = false;
  for (const modifier of modifiers) {
    const lowered = modifier.toLowerCase();
    const target = Object.entries(MODIFIER_ALIASES).find(([name]) => name.toLowerCase() === lowered)?.[1];
    if (target === undefined) {
      return { error: "BROWSER_INVALID_KEY" };
    }
    if (target === "Control") {
      if (control) {
        return { error: "BROWSER_INVALID_KEY" };
      }
      control = true;
    } else if (target === "Shift") {
      if (shift) {
        return { error: "BROWSER_INVALID_KEY" };
      }
      shift = true;
    } else if (target === "Alt") {
      if (alt) {
        return { error: "BROWSER_INVALID_KEY" };
      }
      alt = true;
    } else {
      if (meta) {
        return { error: "BROWSER_INVALID_KEY" };
      }
      meta = true;
    }
  }
  if (canonical === "Space") {
    return {
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
      modifiers: (alt ? 1 : 0) + (control ? 2 : 0) + (meta ? 4 : 0) + (shift ? 8 : 0),
      control,
      shift,
      alt,
      meta,
    };
  }
  return {
    key: resolved.key,
    code: resolved.code,
    windowsVirtualKeyCode: resolved.vk,
    modifiers: (alt ? 1 : 0) + (control ? 2 : 0) + (meta ? 4 : 0) + (shift ? 8 : 0),
    control,
    shift,
    alt,
    meta,
  };
}

/** Resolve a terminal key name to CDP key/code/vk (extension-safe). */
function resolveKeyName(keyName: string): { canonical: string; key: string; code: string; vk: number } | undefined {
  const canonical = SUPPORTED_KEYS[keyName];
  if (canonical !== undefined) {
    if (canonical === "Space") {
      return { canonical, key: " ", code: "Space", vk: 32 };
    }
    const code = canonical === "Enter" ? "Enter" : canonical;
    return { canonical, key: canonical, code, vk: VIRTUAL_KEY_CODES[canonical] ?? 0 };
  }
  // Single letters: preserve case for the key, canonical code is Key+Upper.
  if (/^[a-zA-Z]$/.test(keyName)) {
    const upper = keyName.toUpperCase();
    return { canonical: keyName, key: keyName, code: `Key${upper}`, vk: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/.test(keyName)) {
    return { canonical: keyName, key: keyName, code: `Digit${keyName}`, vk: keyName.charCodeAt(0) };
  }
  const punct = PUNCTUATION_KEY_CODES[keyName];
  if (punct !== undefined) {
    return { canonical: keyName, key: keyName, code: punct.code, vk: punct.vk };
  }
  const upperFn = keyName.toUpperCase();
  const fnVk = FUNCTION_KEY_CODES[upperFn];
  if (fnVk !== undefined) {
    return { canonical: upperFn, key: upperFn, code: upperFn, vk: fnVk };
  }
  return undefined;
}

/** True when the value parses against the allowlist (no CDP needed). */
export function isSupportedPressKey(raw: string): boolean {
  return !("error" in parsePressKey(raw));
}

/** Normalize an optional WPM value; returns the default when undefined. */
export function normalizeWpm(raw: number | undefined): number | null {
  if (raw === undefined) {
    return HUMANIZE_WPM_DEFAULT;
  }
  if (!Number.isInteger(raw) || raw < HUMANIZE_WPM_MIN || raw > HUMANIZE_WPM_MAX) {
    return null;
  }
  return raw;
}

/** Normalize an optional per-key delay; returns the default when undefined. */
export function normalizeSequenceDelayMs(raw: number | undefined): number | null {
  if (raw === undefined) {
    return HUMANIZE_SEQUENCE_DELAY_DEFAULT_MS;
  }
  if (!Number.isInteger(raw) || raw < HUMANIZE_SEQUENCE_DELAY_MIN_MS || raw > HUMANIZE_SEQUENCE_DELAY_MAX_MS) {
    return null;
  }
  return raw;
}

/** Split text into humanize chunks (default 4 chars; extension-safe). */
export function chunkTextForHumanize(text: string, chunkSize: number = TYPE_HUMAN_CHUNK_SIZE): string[] {
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : TYPE_HUMAN_CHUNK_SIZE;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

/**
 * Deterministic per-chunk delay for a WPM rate (no Math.random/Date.now so
 * Node gates and extension timing agree and tests stay deterministic).
 * Base = ms per chunk at 5 chars/word; jitter is a stable ±20% sawtooth
 * from the chunk index; newlines/periods add a brief human pause.
 */
export function humanizeChunkDelayMs(wpm: number, chunkIndex: number, chunk: string): number {
  const safeWpm = Number.isInteger(wpm) && wpm >= HUMANIZE_WPM_MIN && wpm <= HUMANIZE_WPM_MAX ? wpm : HUMANIZE_WPM_DEFAULT;
  const msPerChunk = (60_000 / safeWpm / 5) * TYPE_HUMAN_CHUNK_SIZE;
  const jitterFactor = 0.8 + 0.4 * (((chunkIndex * 37) % 100) / 100);
  let delay = Math.round(msPerChunk * jitterFactor);
  if (chunk.includes("\n")) {
    delay += 120;
  } else if (chunk.includes(".") || chunk.includes(",") || chunk.includes("!") || chunk.includes("?")) {
    delay += 40;
  }
  if (delay < 0) {
    return 0;
  }
  if (delay > HUMANIZE_SEQUENCE_DELAY_MAX_MS) {
    return HUMANIZE_SEQUENCE_DELAY_MAX_MS;
  }
  return delay;
}

/** Injectable randomness: production passes Math.random, tests a seeded stub. */
export type HumanRng = () => number;

/** Standard normal sample via Box-Muller (two uniform draws, stateless). */
export function gauss01(rng: HumanRng = Math.random): number {
  let u1 = rng();
  // Guard the log domain: a zero draw would produce +Infinity.
  if (u1 <= 0) {
    u1 = Number.MIN_VALUE;
  }
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Lognormal sample with a median and shape, clamped to [min, max].
 * Human motor timing is heavy-tailed (lognormal/log-logistic in the
 * keystroke literature), so this replaces uniform jitter everywhere.
 */
export function sampleLognormal(
  median: number,
  sigma: number,
  min: number,
  max: number,
  rng: HumanRng = Math.random,
): number {
  const sample = median * Math.exp(sigma * gauss01(rng));
  if (!Number.isFinite(sample)) {
    return Math.min(Math.max(median, min), max);
  }
  return Math.min(Math.max(sample, min), max);
}

/** Median inter-key flight time for a WPM rate (5 chars/word). */
export function wpmToMedianIkiMs(wpm: number): number {
  const safe = Number.isInteger(wpm) && wpm >= HUMANIZE_WPM_MIN && wpm <= HUMANIZE_WPM_MAX ? wpm : HUMANIZE_WPM_DEFAULT;
  return 60_000 / safe / 5;
}

/**
 * Frequent English digraphs typed materially faster than average
 * (common pairs and different-hand alternation run 20-30% quicker).
 * Lookup is lowercase; both characters must be ASCII letters.
 */
const FAST_DIGRAPHS = new Set(
  "th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur wh ec ot ew gh et fr ow ai rl ss tt oo lf mm".split(" "),
);

/** True for ASCII letters (digraph/dwell fast paths only apply to these). */
function isAsciiletter(char: string): boolean {
  return char.length === 1 && ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z"));
}

export interface KeystrokePlanEntry {
  /** Single code point to emit. */
  readonly char: string;
  /** Flight time since the previous key release (ms, >= 0). */
  readonly flightMs: number;
  /** Hold (dwell) time for this key (ms, >= 0). */
  readonly dwellMs: number;
}

/**
 * Per-character keystroke plan with biometric timing: lognormal flight
 * times around the WPM median (60ms floor from the typing literature),
 * digraph speedups, word/sentence/thinking pauses, and lognormal dwell.
 * Code-point iteration keeps surrogate pairs (emoji) intact as one entry.
 */
export function planKeystrokes(text: string, wpm: number, rng: HumanRng = Math.random): KeystrokePlanEntry[] {
  const median = wpmToMedianIkiMs(wpm);
  const P = HUMAN_PROFILE;
  const chars = Array.from(text);
  const plan: KeystrokePlanEntry[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? "";
    const prev = index === 0 ? "" : (chars[index - 1] ?? "");
    let flight = sampleLognormal(median, P.ikiSigma, P.ikiFloorMs, P.ikiCapMs, rng);
    if (prev !== "" && isAsciiletter(prev) && isAsciiletter(char)) {
      const pair = `${prev.toLowerCase()}${char.toLowerCase()}`;
      if (FAST_DIGRAPHS.has(pair)) {
        flight *= P.digraphSpeedup;
      }
    }
    if (prev === " ") {
      flight += sampleLognormal(P.wordPauseMedianMs, P.wordPauseSigma, 0, P.wordPauseCapMs, rng);
    }
    if (prev === "." || prev === "!" || prev === "?") {
      flight += sampleLognormal(
        P.sentencePauseMedianMs,
        P.sentencePauseSigma,
        P.sentencePauseFloorMs,
        P.sentencePauseCapMs,
        rng,
      );
    }
    if (prev === "\n") {
      flight += sampleLognormal(
        P.newlinePauseMedianMs,
        P.newlinePauseSigma,
        P.newlinePauseFloorMs,
        P.newlinePauseCapMs,
        rng,
      );
    }
    if (index > 0 && rng() < P.thinkingProb) {
      flight += sampleLognormal(
        P.thinkingPauseMedianMs,
        P.thinkingPauseSigma,
        P.thinkingPauseFloorMs,
        P.thinkingPauseCapMs,
        rng,
      );
    }
    const dwell = sampleLognormal(P.dwellMedianMs, P.dwellSigma, P.dwellFloorMs, P.dwellCapMs, rng);
    plan.push({ char, flightMs: Math.round(Math.min(flight, 4000)), dwellMs: Math.round(dwell) });
  }
  return plan;
}

export interface InsertChunkPlan {
  /** 1-4 code points inserted in one CDP call. */
  readonly text: string;
  /** Sleep after this chunk (ms); 0 after the final chunk. */
  readonly delayMs: number;
}

/**
 * Group a keystroke plan into insertText chunks: the chunk boundary
 * carries the accumulated flight timing so insert mode keeps the same
 * rhythm model as keys mode (dwell is not observable via insertText
 * and is therefore dropped here).
 */
export function planInsertChunks(
  text: string,
  wpm: number,
  rng: HumanRng = Math.random,
): InsertChunkPlan[] {
  const keystrokes = planKeystrokes(text, wpm, rng);
  const chunks: InsertChunkPlan[] = [];
  let index = 0;
  while (index < keystrokes.length) {
    const size = 1 + Math.floor(rng() * 4);
    const slice = keystrokes.slice(index, index + size);
    const chars = slice.map((entry) => entry.char).join("");
    const trailing = keystrokes[index + slice.length];
    const delay = trailing === undefined ? 0 : slice.reduce((sum, entry) => sum + entry.flightMs, 0) + trailing.flightMs;
    chunks.push({ text: chars, delayMs: Math.min(Math.round(delay), 4000) });
    index += slice.length;
  }
  return chunks;
}

/** 2D point in CSS pixels (viewport coordinates for CDP mouse events). */
export interface MousePoint {
  readonly x: number;
  readonly y: number;
}

/** Timed waypoint: cursor position plus sleep-after calories in ms. */
export interface MouseWaypoint extends MousePoint {
  readonly dtMs: number;
}

export interface MouseMovePlan {
  readonly points: readonly MouseWaypoint[];
  /** Total replay duration in ms (sum of dtMs). */
  readonly durationMs: number;
}

/** Hard safety caps for the mouse path (never fitted, never tuned). */
export const MOUSE_MAX_TOTAL_MS = 2500;
export const MOUSE_SAMPLE_INTERVAL_MS = 8;
export const MOUSE_MAX_STEPS = 250;
export const MOUSE_MIN_MOVE_MS = 120;
export const MOUSE_MAX_MOVE_MS = 2000;

function cubicBezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Raised-cosine position profile: zero velocity at both ends, peak mid-flight. */
function raisedCosine(t: number): number {
  return t - Math.sin(2 * Math.PI * t) / (2 * Math.PI);
}

/**
 * Neuromotor mouse trajectory: Shannon Fitts-law timing, cubic Bezier arc
 * (one-sided lateral deviation, never a perfect center line), half-normal
 * overshoot on long moves, 0-3 corrective submovements, and sinusoidal
 * hand tremor — replayed at ~120Hz. All shape parameters are resampled per
 * call so repeated moves never share one fingerprintable distribution.
 * The final point lands exactly on `to`.
 */
export function planMouseMove(
  from: MousePoint,
  to: MousePoint,
  targetWidthPx: number,
  rng: HumanRng = Math.random,
): MouseMovePlan {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!(distance >= 2)) {
    return { points: [{ x: to.x, y: to.y, dtMs: 0 }], durationMs: 0 };
  }
  const width = Number.isFinite(targetWidthPx) && targetWidthPx > 0 ? targetWidthPx : 8;
  const P = HUMAN_PROFILE;
  const fitts = P.fittsAMs + P.fittsBMs * Math.log2(1 + (2 * distance) / Math.max(width, 8));
  const moveMs = Math.min(Math.max(fitts, MOUSE_MIN_MOVE_MS), MOUSE_MAX_MOVE_MS);
  const side = rng() < 0.5 ? 1 : -1;
  const curveAmp = (P.curveMinFraction + rng() * (P.curveMaxFraction - P.curveMinFraction)) * distance * side;
  const cp1f = 0.3 + rng() * 0.15;
  const cp2f = 0.65 + rng() * 0.15;
  const nx = -dy / distance;
  const ny = dx / distance;
  let overshoot = 0;
  if (distance > P.overshootMinDistPx) {
    overshoot = Math.abs(gauss01(rng)) * P.overshootSigmaPx;
  }
  const p3x = to.x + (dx / distance) * overshoot;
  const p3y = to.y + (dy / distance) * overshoot;
  const p1x = from.x + dx * cp1f + nx * curveAmp * 0.7;
  const p1y = from.y + dy * cp1f + ny * curveAmp * 0.7;
  const p2x = from.x + dx * cp2f + nx * curveAmp * 0.4;
  const p2y = from.y + dy * cp2f + ny * curveAmp * 0.4;
  const steps = Math.min(Math.max(Math.round(moveMs / MOUSE_SAMPLE_INTERVAL_MS), 8), MOUSE_MAX_STEPS);
  const tremorFreqX = P.tremorFreqMinHz + rng() * (P.tremorFreqMaxHz - P.tremorFreqMinHz);
  const tremorFreqY = P.tremorFreqMinHz + rng() * (P.tremorFreqMaxHz - P.tremorFreqMinHz);
  const tremorPhaseX = rng() * 2 * Math.PI;
  const tremorPhaseY = rng() * 2 * Math.PI;
  const points: MouseWaypoint[] = [];
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const u = raisedCosine(t);
    const elapsed = (index / steps) * moveMs;
    const tremorX = P.tremorAmpPx * Math.sin(2 * Math.PI * tremorFreqX * (elapsed / 1000) + tremorPhaseX);
    const tremorY = P.tremorAmpPx * Math.sin(2 * Math.PI * tremorFreqY * (elapsed / 1000) + tremorPhaseY);
    points.push({
      x: cubicBezier(from.x, p1x, p2x, p3x, u) + tremorX,
      y: cubicBezier(from.y, p1y, p2y, p3y, u) + tremorY,
      dtMs: moveMs / steps,
    });
  }
  // Corrective submovements: each covers 30-60% of the residual error on a
  // short eased segment; the last one lands exactly on the target.
  const corrections = distance > P.overshootMinDistPx ? 1 + Math.floor(rng() * 3) : distance > 80 ? (rng() < 0.5 ? 1 : 0) : 0;
  let cursor = { x: p3x, y: p3y };
  for (let correction = 0; correction < corrections; correction += 1) {
    const last = correction === corrections - 1;
    const fraction = last ? 1 : 0.3 + rng() * 0.3;
    const target = last
      ? { x: to.x, y: to.y }
      : { x: cursor.x + (to.x - cursor.x) * fraction, y: cursor.y + (to.y - cursor.y) * fraction };
    const duration = moveMs * (0.08 + rng() * 0.12);
    const subSteps = Math.max(2, Math.round(duration / MOUSE_SAMPLE_INTERVAL_MS));
    for (let index = 1; index <= subSteps; index += 1) {
      const u = raisedCosine(index / subSteps);
      points.push({
        x: cursor.x + (target.x - cursor.x) * u,
        y: cursor.y + (target.y - cursor.y) * u,
        dtMs: duration / subSteps,
      });
    }
    cursor = target;
  }
  // Hard total budget: scale sleeps uniformly rather than dropping the tail.
  const total = points.reduce((sum, point) => sum + point.dtMs, 0);
  if (total > MOUSE_MAX_TOTAL_MS && total > 0) {
    const scale = MOUSE_MAX_TOTAL_MS / total;
    const scaled = points.map((point) => ({ ...point, dtMs: point.dtMs * scale }));
    return { points: scaled, durationMs: MOUSE_MAX_TOTAL_MS };
  }
  return { points, durationMs: total };
}

/**
 * Jittered click point inside an element box: gaussian offset scaled to
 * 18% of the half-size, clamped inside with a 1px margin. Humans rarely
 * hit the exact center twice; clamping keeps every click on-target
 * (an outside "miss" could activate the wrong element, so misses are
 * modeled as short-stop approaches inside the submovement structure,
 * never as off-target clicks).
 */
export function jitterClickPoint(
  box: { minX: number; minY: number; maxX: number; maxY: number },
  rng: HumanRng = Math.random,
): MousePoint {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const sigmaX = Math.max((box.maxX - box.minX) / 2, 1) * HUMAN_PROFILE.clickJitterFraction;
  const sigmaY = Math.max((box.maxY - box.minY) / 2, 1) * HUMAN_PROFILE.clickJitterFraction;
  const x = Math.min(Math.max(cx + gauss01(rng) * sigmaX, box.minX + 1), Math.max(box.maxX - 1, box.minX + 1));
  const y = Math.min(Math.max(cy + gauss01(rng) * sigmaY, box.minY + 1), Math.max(box.maxY - 1, box.minY + 1));
  return { x, y };
}

/** Pre-click hover dwell: lognormal around the profile median. */
export function hoverDwellMs(rng: HumanRng = Math.random): number {
  const P = HUMAN_PROFILE;
  return Math.round(sampleLognormal(P.hoverMedianMs, P.hoverSigma, P.hoverFloorMs, P.hoverCapMs, rng));
}

/** Mouse-button hold time: lognormal around the profile median. */
export function pressHoldMs(rng: HumanRng = Math.random): number {
  const P = HUMAN_PROFILE;
  return Math.round(sampleLognormal(P.holdMedianMs, P.holdSigma, P.holdFloorMs, P.holdCapMs, rng));
}

/** Typing modes for humanized entry. */
export type HumanTypeMode = "keys" | "insert";

export const HUMAN_TYPE_MODE_DEFAULT: HumanTypeMode = "keys";

/** Normalize an optional typing mode; defaults to keys (real key events). */
export function normalizeHumanTypeMode(raw: unknown): HumanTypeMode | null {
  if (raw === undefined) {
    return HUMAN_TYPE_MODE_DEFAULT;
  }
  if (raw === "keys" || raw === "insert") {
    return raw;
  }
  return null;
}

/** Character budget for keys mode (real events are slower than inserts). */
export const HUMAN_KEYS_MODE_MAX_CHARS = 1500;
