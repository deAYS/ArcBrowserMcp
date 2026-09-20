/**
 * Shared interaction policy (Node + extension, dependency-free).
 *
 * Owns the browser-neutral interaction boundaries so both sides enforce the
 * same contract without duplicating magic values:
 * - UTF-8 byte limit for fill/type text (hard cap, fail before any CDP).
 * - pressKey allowlist: supported keys + modifiers, with Windows-key-code
 *   mapping data the extension translates to CDP Input.dispatchKeyEvent.
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
 * key name otherwise). Returns the parsed spec or an invalid marker;
 * callers map the marker to BROWSER_INVALID_KEY before any bridge traffic.
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
  const canonical = SUPPORTED_KEYS[keyName];
  if (canonical === undefined) {
    return { error: "BROWSER_INVALID_KEY" };
  }
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
  const code = canonical === "Enter" ? "Enter" : canonical;
  return {
    key: canonical,
    code,
    windowsVirtualKeyCode: VIRTUAL_KEY_CODES[canonical] ?? 0,
    modifiers: (alt ? 1 : 0) + (control ? 2 : 0) + (meta ? 4 : 0) + (shift ? 8 : 0),
    control,
    shift,
    alt,
    meta,
  };
}

/** True when the value parses against the allowlist (no CDP needed). */
export function isSupportedPressKey(raw: string): boolean {
  return !("error" in parsePressKey(raw));
}
