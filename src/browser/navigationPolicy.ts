/**
 * Authoritative navigation URL policy (shared by Node + extension).
 *
 * One parser-backed gate replaces scattered scheme regexes. Node
 * (engine/service/tool) validates before any bridge traffic; the extension
 * revalidates at the boundary before touching chrome.tabs. The module is
 * dependency-free on purpose so the extension bundle can import it.
 */

export type UrlPolicyRejection =
  | "NOT_ABSOLUTE_URL"
  | "SCHEME_NOT_ALLOWED"
  | "EMBEDDED_CREDENTIALS"
  | "CONTROL_CHARACTERS";

export interface UrlPolicyFailure {
  readonly reason: UrlPolicyRejection;
  readonly detail: string;
}

/** Navigable destination schemes for browser_navigate. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Control characters are never valid in a navigated URL. */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;

function hasControlCharacters(raw: string): boolean {
  return CONTROL_CHAR_PATTERN.test(raw);
}

/**
 * Validate a navigation destination. Returns the normalized absolute URL
 * string on success (URL's own serialization, preserving path/query/fragment
 * semantics) or a typed failure. Local/private HTTP addresses are allowed:
 * this is a user-controlled browser, not a server-side fetcher, so no
 * SSRF-style host blocklist is applied.
 */
export function validateNavigationUrl(raw: string): { ok: true; url: string } | { ok: false; failure: UrlPolicyFailure } {
  if (hasControlCharacters(raw)) {
    return { ok: false, failure: { reason: "CONTROL_CHARACTERS", detail: "URL contains control characters" } };
  }
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      failure: { reason: "NOT_ABSOLUTE_URL", detail: "URL must be an absolute HTTP or HTTPS URL" },
    };
  }
  const scheme = parsed.protocol.toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) {
    return {
      ok: false,
      failure: { reason: "SCHEME_NOT_ALLOWED", detail: `URL scheme ${JSON.stringify(scheme)} is not allowed` },
    };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      failure: { reason: "EMBEDDED_CREDENTIALS", detail: "URLs with embedded credentials are not allowed" },
    };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * Narrow source-tab gate for navigation commands: the currently selected
 * tab must be an ordinary HTTP/HTTPS tab or about:blank (the state a fresh
 * disposable tab is in before its first navigation).
 */
export function isNavigableSourceUrl(url: string): boolean {
  return url === "" || url.toLowerCase() === "about:blank" || /^https?:/i.test(url);
}
