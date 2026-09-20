import { describe, expect, it } from "vitest";
import {
  REDACTED_VALUE,
  isSensitiveHeaderName,
  isSensitiveQueryParam,
  redactConsoleText,
  redactHeaders,
  sanitizeUrl,
} from "../src/security/Redaction.js";

/**
 * P09 redaction unit tests (mocked, deterministic, no browser).
 *
 * Sentinel values stand in for credentials; tests never print raw sentinels
 * on success (assertions check absence from serialized results). Mixed-case
 * header names are mandatory coverage.
 */

const BEARER_SENTINEL = "p09-bearer-sentinel-9f2c41";
const BASIC_SENTINEL = "cG09YmFzaWMtc2VudGluZWw=";
const TOKEN_SENTINEL = "p09-token-sentinel-77aa10";
const COOKIE_SENTINEL = "p09-cookie-sentinel-31bd88";
const URL_SECRET = "p09-url-secret-5e07c2";
const BODY_SENTINEL = "p09-body-sentinel-9d41ab-must-never-appear";

describe("P09 header redaction", () => {
  it("redacts Authorization in any casing without preserving prefixes", () => {
    for (const name of ["Authorization", "authorization", "aUtHoRiZaTiOn"]) {
      const out = redactHeaders({ [name]: `Bearer ${BEARER_SENTINEL}` });
      expect(out[name]).toBe(REDACTED_VALUE);
      expect(JSON.stringify(out)).not.toContain(BEARER_SENTINEL);
      expect(JSON.stringify(out)).not.toContain("Bearer ");
    }
  });

  it("redacts Cookie, Set-Cookie, Proxy-Authorization in mixed casing", () => {
    const out = redactHeaders({
      COOKIE: COOKIE_SENTINEL,
      "set-cookie": `session=${COOKIE_SENTINEL}`,
      "Proxy-Authorization": `Basic ${BASIC_SENTINEL}`,
    });
    expect(out["COOKIE"]).toBe(REDACTED_VALUE);
    expect(out["set-cookie"]).toBe(REDACTED_VALUE);
    expect(out["Proxy-Authorization"]).toBe(REDACTED_VALUE);
    expect(JSON.stringify(out)).not.toContain(COOKIE_SENTINEL);
    expect(JSON.stringify(out)).not.toContain(BASIC_SENTINEL);
  });

  it("redacts X-Api-Key / X-Auth-Token and preserves safe headers", () => {
    const out = redactHeaders({
      "X-Api-Key": TOKEN_SENTINEL,
      "x-auth-token": TOKEN_SENTINEL,
      "Content-Type": "application/json",
    });
    expect(out["X-Api-Key"]).toBe(REDACTED_VALUE);
    expect(out["x-auth-token"]).toBe(REDACTED_VALUE);
    expect(out["Content-Type"]).toBe("application/json");
    expect(JSON.stringify(out)).not.toContain(TOKEN_SENTINEL);
  });

  it("isSensitiveHeaderName is case-insensitive", () => {
    expect(isSensitiveHeaderName("Authorization")).toBe(true);
    expect(isSensitiveHeaderName("COOKIE")).toBe(true);
    expect(isSensitiveHeaderName("X-API-KEY")).toBe(true);
    expect(isSensitiveHeaderName("Content-Type")).toBe(false);
  });
});

describe("P09 URL redaction", () => {
  it("redacts sensitive query values and preserves safe params", () => {
    const sanitized = sanitizeUrl(`https://example.test/api?access_token=${URL_SECRET}&page=2`);
    expect(sanitized).toContain("access_token=[REDACTED]");
    expect(sanitized).toContain("page=2");
    expect(sanitized).not.toContain(URL_SECRET);
  });

  it("redacts token/password/api_key variants", () => {
    for (const param of ["token", "password", "api_key", "secret"]) {
      expect(isSensitiveQueryParam(param)).toBe(true);
      const sanitized = sanitizeUrl(`https://example.test/x?${param}=${URL_SECRET}&safe=1`);
      expect(sanitized).not.toContain(URL_SECRET);
      expect(sanitized).toContain("safe=1");
    }
    expect(isSensitiveQueryParam("page")).toBe(false);
  });

  it("strips embedded username/password credentials", () => {
    const sanitized = sanitizeUrl(`https://user:${URL_SECRET}@example.test/path?q=1`);
    expect(sanitized).not.toContain(URL_SECRET);
    expect(sanitized).not.toContain("user@");
    expect(sanitized).toContain("example.test/path");
  });

  it("redacts sensitive fragment values (implicit-flow URLs)", () => {
    const sanitized = sanitizeUrl(`https://example.test/cb#access_token=${URL_SECRET}&state=ok`);
    expect(sanitized).not.toContain(URL_SECRET);
    expect(sanitized).toContain("access_token=[REDACTED]");
  });

  it("handles malformed URLs conservatively without throwing raw content", () => {
    const out = sanitizeUrl("::::not a url at all::::");
    expect(typeof out).toBe("string");
    expect(out.length).toBeLessThanOrEqual(2048);
    const withSecret = sanitizeUrl(`http://[:::bad?password=${URL_SECRET}`);
    expect(withSecret).not.toContain(URL_SECRET);
  });
});

describe("P09 console text redaction", () => {
  it("redacts Bearer and Basic credentials (any scheme casing)", () => {
    expect(redactConsoleText(`calling with Bearer ${BEARER_SENTINEL} now`)).toBe(
      "calling with Bearer [REDACTED] now",
    );
    const lower = redactConsoleText(`calling with bearer ${BEARER_SENTINEL} now`);
    expect(lower).not.toContain(BEARER_SENTINEL);
    const basic = redactConsoleText(`auth Basic ${BASIC_SENTINEL} end`);
    expect(basic).toContain("[REDACTED]");
    expect(basic).not.toContain(BASIC_SENTINEL);
  });

  it("redacts key=value credential forms", () => {
    const out = redactConsoleText(`login token=${TOKEN_SENTINEL} done`);
    expect(out).toContain("token=[REDACTED]");
    expect(out).not.toContain(TOKEN_SENTINEL);
  });

  it("bounds output and never echoes RemoteObject content by itself", () => {
    const long = redactConsoleText(`Bearer ${BEARER_SENTINEL} ${"x".repeat(10_000)}`);
    expect(long.length).toBeLessThanOrEqual(4000);
    expect(long).not.toContain(BEARER_SENTINEL);
  });

  it("body sentinel never survives serialized redacted output", () => {
    const serialized = JSON.stringify({
      headers: redactHeaders({ Authorization: BODY_SENTINEL }),
      url: sanitizeUrl(`https://example.test/?token=${BODY_SENTINEL}`),
      text: redactConsoleText(`Bearer ${BODY_SENTINEL}`),
    });
    expect(serialized).not.toContain(BODY_SENTINEL);
  });
});
