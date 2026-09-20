/**
 * Central redaction for P09 console/network observability (Node + extension,
 * dependency-free).
 *
 * Pure and deterministic: no Node APIs, no chrome.*, no randomness, no
 * timestamps. Used as close to the raw event boundary as practical
 * (extension-side) so credentials are redacted BEFORE crossing the
 * extension/native-host/pipe boundary. Node re-applies the same helpers as
 * defense-in-depth before MCP output.
 *
 * Guarantees (strict):
 * - Structured header values for Authorization, Cookie, Set-Cookie,
 *   Proxy-Authorization (case-insensitive) are ALWAYS replaced wholesale
 *   with "[REDACTED]". No prefix preservation (never "Bearer abc...").
 * - Additional credential headers X-Api-Key / X-Auth-Token are also
 *   redacted centrally (encouraged by the phase spec).
 * - URL query values for sensitive parameter names are replaced, embedded
 *   username/password credentials are stripped, unparseable URLs use a
 *   bounded conservative fallback.
 *
 * Heuristic (best-effort, documented as imperfect):
 * - Arbitrary console text gets bounded pattern redaction for obvious
 *   credential forms (Bearer/Basic + key=value shapes). The strict header/URL
 *   guarantee above remains the security boundary; console heuristics are
 *   defense-in-depth only.
 */

export const REDACTED_VALUE = "[REDACTED]";

/** Lowercased sensitive header names (exact match, case-insensitive). */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);

/** Lowercased sensitive URL query parameter names (exact match). */
const SENSITIVE_QUERY_PARAMS = new Set([
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "api_key",
  "apikey",
  "password",
  "passwd",
  "secret",
  "auth",
  "authorization",
]);

/** Max chars for any single redacted string output (bounds, never unbounded). */
export const REDACTION_MAX_STRING_CHARS = 2048;
/** Max chars for a sanitized URL. */
export const REDACTION_MAX_URL_CHARS = 2048;
/** Max chars for heuristic console-text redaction output. */
export const REDACTION_MAX_CONSOLE_TEXT_CHARS = 4000;

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/** True when the header name must have its value fully redacted. */
export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.trim().toLowerCase());
}

/**
 * Redact a header map: sensitive names keep their name with a fully replaced
 * value; all other headers pass through with bounded values. Never preserves
 * prefixes such as "Bearer ...".
 */
export function redactHeaders(
  headers: Record<string, string> | undefined,
  maxValueChars = 1024,
): Record<string, string> {
  if (headers === undefined) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      continue;
    }
    if (isSensitiveHeaderName(name)) {
      out[name] = REDACTED_VALUE;
    } else {
      out[name] = truncate(value, maxValueChars);
    }
  }
  return out;
}

/** True when the query parameter name must have its value redacted. */
export function isSensitiveQueryParam(name: string): boolean {
  return SENSITIVE_QUERY_PARAMS.has(name.trim().toLowerCase());
}

/**
 * Conservative URL sanitization:
 * - Embedded username/password are stripped (never returned).
 * - Sensitive query values become [REDACTED]; safe params preserved.
 * - Output bounded to maxChars.
 * - Unparseable input uses a bounded heuristic fallback (never throws raw
 *   content outward, never returns unbounded text).
 */
export function sanitizeUrl(rawUrl: string, maxChars: number = REDACTION_MAX_URL_CHARS): string {
  if (typeof rawUrl !== "string") {
    return "";
  }
  const boundedInput = truncate(rawUrl, maxChars + 512);
  try {
    const parsed = new URL(boundedInput);
    // Strip embedded credentials entirely (fail closed: removal, not echo).
    if (parsed.username !== "" || parsed.password !== "") {
      parsed.username = "";
      parsed.password = "";
    }
    // Fragments can carry credentials (implicit OAuth flow): redact
    // sensitive key=value pairs there too (best-effort, bounded).
    if (parsed.hash !== "") {
      const redactedHash = redactFragmentSecrets(parsed.hash);
      if (redactedHash !== parsed.hash) {
        parsed.hash = redactedHash;
      }
    }
    // Redact sensitive query values, preserving safe params and order.
    // Note: URLSearchParams percent-encodes "[REDACTED]" as %5BREDACTED%5D;
    // decode it back so public output contains the literal sentinel token
    // the phase spec and tests expect (still a valid URL rendering).
    const params = parsed.searchParams;
    let mutated = false;
    const names: string[] = [];
    params.forEach((_value, key) => {
      names.push(key);
    });
    for (const key of names) {
      if (isSensitiveQueryParam(key)) {
        params.set(key, REDACTED_VALUE);
        mutated = true;
      }
    }
    void mutated;
    const serialized = parsed
      .toString()
      .replaceAll("%5BREDACTED%5D", REDACTED_VALUE)
      .replaceAll("%5Bredacted%5D", REDACTED_VALUE)
      .replaceAll("%5bredacted%5d", REDACTED_VALUE);
    return truncate(serialized, maxChars);
  } catch {
    // Bounded conservative fallback: heuristic key=value redaction over a
    // truncated slice, never the raw unbounded input.
    const slice = truncate(boundedInput, maxChars);
    return truncate(redactKeyValueSecrets(slice), maxChars);
  }
}

/**
 * Heuristic key=value secret redaction for free-form text (console text,
 * fallback URLs). Replaces values for obvious credential keys with
 * [REDACTED]. Case-insensitive key match. Best-effort only; structured
 * headers/URLs above remain the strict boundary.
 */
function redactKeyValueSecrets(text: string): string {
  // Matches token=VALUE, access_token:VALUE, password="VALUE", etc. Value runs
  // to the next delimiter (& ; \s " ' `) or end. Bounded replacement.
  return text.replace(
    /((?:token|access_token|id_token|refresh_token|api_key|apikey|password|passwd|secret|auth|authorization))\s*[:=]\s*("[^"]{0,256}"|'[^']{0,256}'|`[^`]{0,256}`|[^\s&;"'`]{1,256})/gi,
    (_match, key: string) => `${key}=[REDACTED]`,
  );
}

/** Redact sensitive key=value pairs inside a URL fragment (#...). */
function redactFragmentSecrets(hash: string): string {
  return truncate(redactKeyValueSecrets(hash), REDACTION_MAX_URL_CHARS);
}

/**
 * Bounded heuristic redaction for arbitrary console text:
 * - Bearer <credential> -> Bearer [REDACTED]
 * - Basic <credential> -> Basic [REDACTED]
 * - key=value credential forms -> key=[REDACTED]
 * Output bounded to maxChars. Never throws.
 */
export function redactConsoleText(text: string, maxChars: number = REDACTION_MAX_CONSOLE_TEXT_CHARS): string {
  if (typeof text !== "string") {
    return "";
  }
  let out = truncate(text, maxChars + 512);
  // Bearer/Basic schemes: replace the credential token wholesale
  // (case-insensitive scheme word; the replacement normalizes the scheme to
  // its canonical Bearer/Basic casing). The combined alternation avoids a
  // first-pass rewrite shifting text in ways the second pass cannot match.
  out = out.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/=]{1,512}/gi,
    (_m, scheme: string) => `${String(scheme).toLowerCase() === "basic" ? "Basic" : "Bearer"} ${REDACTED_VALUE}`,
  );
  out = redactKeyValueSecrets(out);
  return truncate(out, maxChars);
}
