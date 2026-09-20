import { describe, expect, it } from "vitest";
import { isNavigableSourceUrl, validateNavigationUrl } from "../src/browser/navigationPolicy.js";

describe("URL policy validation", () => {
  it.each(["https://example.com/", "HTTPS://EXAMPLE.COM/Path", "http://localhost:3000/", "http://127.0.0.1/", "http://intranet/page?q=1#f"])(
    "accepts %s",
    (url) => {
      const result = validateNavigationUrl(url);
      expect(result.ok).toBe(true);
    },
  );

  it.each([
    ["javascript:alert(1)", "SCHEME_NOT_ALLOWED"],
    ["JaVaScRiPt:alert(1)", "SCHEME_NOT_ALLOWED"],
    ["data:text/html,x", "SCHEME_NOT_ALLOWED"],
    ["file:///etc/passwd", "SCHEME_NOT_ALLOWED"],
    ["chrome://settings", "SCHEME_NOT_ALLOWED"],
    ["chrome-extension://abc/page", "SCHEME_NOT_ALLOWED"],
    ["arc://extensions", "SCHEME_NOT_ALLOWED"],
    ["devtools://devtools/bundled/inspector.html", "SCHEME_NOT_ALLOWED"],
    ["view-source:https://example.com/", "SCHEME_NOT_ALLOWED"],
    ["not a url", "NOT_ABSOLUTE_URL"],
    ["", "NOT_ABSOLUTE_URL"],
    ["   ", "NOT_ABSOLUTE_URL"],
    ["https://user:password@example.com/", "EMBEDDED_CREDENTIALS"],
    ["https://user@example.com/", "EMBEDDED_CREDENTIALS"],
    ["https://example.com/\u0000", "CONTROL_CHARACTERS"],
  ])("rejects %s with %s", (url, reason) => {
    const result = validateNavigationUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe(reason);
    }
  });

  it("normalizes through a real parser, preserving query/fragment", () => {
    const result = validateNavigationUrl("HTTPS://example.com/a?b=1#c");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.startsWith("https://example.com/")).toBe(true);
      expect(result.url).toContain("?b=1#c");
    }
  });
});

describe("navigable source tabs", () => {
  it("allows http/https, blank, and empty (uncommitted) tabs", () => {
    expect(isNavigableSourceUrl("https://example.com/")).toBe(true);
    expect(isNavigableSourceUrl("http://localhost/")).toBe(true);
    expect(isNavigableSourceUrl("about:blank")).toBe(true);
    expect(isNavigableSourceUrl("ABOUT:BLANK")).toBe(true);
    expect(isNavigableSourceUrl("")).toBe(true);
  });

  it("rejects privileged browser pages", () => {
    for (const url of [
      "chrome://extensions/",
      "arc://extensions",
      "chrome-extension://abc/page.html",
      "devtools://devtools/bundled/inspector.html",
    ]) {
      expect(isNavigableSourceUrl(url)).toBe(false);
    }
  });
});
