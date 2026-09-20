import { describe, expect, it } from "vitest";
import { ConfigError, defaultConfig, loadConfig } from "../src/config/config.js";

describe("arcExecutablePath environment configuration", () => {
  it("prefers ARC_MCP_ARC_EXECUTABLE_PATH over the legacy alias", () => {
    const config = loadConfig({
      ARC_MCP_ARC_EXECUTABLE_PATH: "C:\\Arc\\Arc.exe",
      ARC_MCP_EXECUTABLE_PATH: "D:\\Other\\Arc.exe",
    });
    expect(config.arcExecutablePath).toBe("C:\\Arc\\Arc.exe");
  });

  it("falls back to ARC_MCP_EXECUTABLE_PATH when canonical is absent", () => {
    const config = loadConfig({ ARC_MCP_EXECUTABLE_PATH: "D:\\Other\\Arc.exe" });
    expect(config.arcExecutablePath).toBe("D:\\Other\\Arc.exe");
  });

  it("leaves arcExecutablePath undefined when neither is set", () => {
    expect(loadConfig({}).arcExecutablePath).toBeUndefined();
  });
});

describe("extensionConnectTimeoutMs configuration", () => {
  it("defaults to 120000ms", () => {
    expect(defaultConfig().extensionConnectTimeoutMs).toBe(120_000);
    expect(loadConfig({}).extensionConnectTimeoutMs).toBe(120_000);
  });

  it("parses an explicit millisecond override", () => {
    expect(loadConfig({ ARC_MCP_EXTENSION_CONNECT_TIMEOUT_MS: "30000" }).extensionConnectTimeoutMs).toBe(30_000);
  });

  it("rejects non-positive values", () => {
    expect(() => loadConfig({ ARC_MCP_EXTENSION_CONNECT_TIMEOUT_MS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ARC_MCP_EXTENSION_CONNECT_TIMEOUT_MS: "soon" })).toThrow(ConfigError);
  });
});
