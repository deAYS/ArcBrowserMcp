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
