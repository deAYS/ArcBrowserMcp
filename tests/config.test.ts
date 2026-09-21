import { describe, expect, it } from "vitest";
import { ConfigError, defaultConfig, loadConfig } from "../src/config/index.js";

describe("defaultConfig", () => {
  it("provides safe defaults", () => {
    const config = defaultConfig();
    expect(config.browser).toBe("arc");
    expect(config.debugPort).toBe(9222);
    // No CWD-relative profile default.
    // An absent ARC_MCP_PROFILE_PATH leaves profilePath undefined so
    // the chromium profile module resolves the stable per-user default.
    expect(config.profilePath).toBeUndefined();
    expect(config.executablePath).toBeUndefined();
    expect(config.allowEvaluate).toBe(false);
    expect(config.allowDownloads).toBe(false);
    expect(config.allowedOrigins).toEqual([]);
    expect(config.deniedOrigins).toEqual([]);
    expect(config.logLevel).toBe("info");
    expect(config.consoleBufferEntries).toBe(200);
    expect(config.networkBufferEntries).toBe(500);
  });
});

describe("loadConfig", () => {
  it("parses environment overrides", () => {
    const config = loadConfig({
      ARC_MCP_BROWSER: "chrome",
      ARC_MCP_DEBUG_PORT: "9333",
      ARC_MCP_PROFILE_PATH: "./data/test-profile",
      ARC_MCP_EXECUTABLE_PATH: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      ARC_MCP_ALLOWED_ORIGINS: "https://example.com, https://example.org",
      ARC_MCP_DENIED_ORIGINS: "https://evil.example",
      ARC_MCP_ALLOW_EVALUATE: "true",
      ARC_MCP_ALLOW_DOWNLOADS: "false",
      ARC_MCP_LOG_LEVEL: "debug",
    });
    expect(config.browser).toBe("chrome");
    expect(config.debugPort).toBe(9333);
    expect(config.profilePath).toBe("./data/test-profile");
    expect(config.executablePath).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    expect(config.allowedOrigins).toEqual(["https://example.com", "https://example.org"]);
    expect(config.deniedOrigins).toEqual(["https://evil.example"]);
    expect(config.allowEvaluate).toBe(true);
    expect(config.allowDownloads).toBe(false);
    expect(config.logLevel).toBe("debug");
  });

  it("accepts both supported browser ids in any case", () => {
    expect(loadConfig({ ARC_MCP_BROWSER: "arc" }).browser).toBe("arc");
    expect(loadConfig({ ARC_MCP_BROWSER: "CHROME" }).browser).toBe("chrome");
    expect(loadConfig({ ARC_MCP_BROWSER: "" }).browser).toBe("arc");
    expect(loadConfig({}).browser).toBe("arc");
  });

  it("rejects an unsupported browser id", () => {
    expect(() => loadConfig({ ARC_MCP_BROWSER: "firefox" })).toThrow(ConfigError);
  });

  it("ARC_MCP_EXECUTABLE_PATH is canonical; the deprecated Arc alias loses", () => {
    expect(loadConfig({ ARC_MCP_EXECUTABLE_PATH: "C:\\Chrome\\chrome.exe" }).executablePath).toBe("C:\\Chrome\\chrome.exe");
    expect(loadConfig({ ARC_MCP_ARC_EXECUTABLE_PATH: "C:\\Arc\\Arc.exe" }).executablePath).toBe("C:\\Arc\\Arc.exe");
    expect(
      loadConfig({
        ARC_MCP_EXECUTABLE_PATH: "C:\\Chrome\\chrome.exe",
        ARC_MCP_ARC_EXECUTABLE_PATH: "C:\\Arc\\Arc.exe",
      }).executablePath,
    ).toBe("C:\\Chrome\\chrome.exe");
  });

  it("rejects an out-of-range debug port", () => {
    expect(() => loadConfig({ ARC_MCP_DEBUG_PORT: "99999" })).toThrow(ConfigError);
  });

  it("rejects an unknown log level", () => {
    expect(() => loadConfig({ ARC_MCP_LOG_LEVEL: "verbose" })).toThrow(ConfigError);
  });

  it("rejects a malformed boolean", () => {
    expect(() => loadConfig({ ARC_MCP_ALLOW_EVALUATE: "maybe" })).toThrow(ConfigError);
  });

  it("parses observability buffer overrides and rejects invalid capacities", () => {
    expect(
      loadConfig({ ARC_MCP_CONSOLE_BUFFER_ENTRIES: "1000", ARC_MCP_NETWORK_BUFFER_ENTRIES: "2500" }),
    ).toMatchObject({ consoleBufferEntries: 1000, networkBufferEntries: 2500 });
    for (const env of [
      { ARC_MCP_CONSOLE_BUFFER_ENTRIES: "0" },
      { ARC_MCP_CONSOLE_BUFFER_ENTRIES: "-5" },
      { ARC_MCP_CONSOLE_BUFFER_ENTRIES: "2001" },
      { ARC_MCP_NETWORK_BUFFER_ENTRIES: "5001" },
      { ARC_MCP_NETWORK_BUFFER_ENTRIES: "nope" },
    ]) {
      expect(() => loadConfig(env)).toThrow(ConfigError);
    }
  });
});
