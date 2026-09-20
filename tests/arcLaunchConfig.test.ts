import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { ConfigError } from "../src/config/config.js";
import { ArcError } from "../src/errors/ArcError.js";
import { resolveMcpProfilePath } from "../src/browser/arc/ArcProfile.js";
import { buildArcLaunchConfig } from "../src/browser/arc/ArcLaunchConfig.js";

describe("Arc launch configuration builder", () => {
  it("builds executable, dedicated profile, port, and array args without spawning", () => {
    const exe = path.resolve("C:\\Arc\\Arc.exe");
    const config = buildArcLaunchConfig({
      executablePath: exe,
      profilePath: path.resolve("C:\\arc-mcp-data\\profile"),
      debugPort: 9222,
    });
    expect(config.executablePath).toBe(exe);
    expect(config.debugPort).toBe(9222);
    expect(Array.isArray(config.args)).toBe(true);
    expect(config.args).toHaveLength(3);
    expect(config.args[0]).toBe(`--user-data-dir=${config.profilePath}`);
    expect(config.args[1]).toBe("--remote-debugging-port=9222");
    expect(config.args[2]).toBe("--remote-debugging-address=127.0.0.1");
  });

  it("adds no security-weakening flags", () => {
    const config = buildArcLaunchConfig({
      executablePath: path.resolve("C:\\Arc\\Arc.exe"),
      profilePath: path.resolve("C:\\arc-mcp-data\\profile"),
      debugPort: 9222,
    });
    const joined = config.args.join(" ").toLowerCase();
    for (const token of ["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors", "--disable-site-isolation", "--disable-web-security", "--allow-running-insecure-content"]) {
      expect(joined, `must not contain ${token}`).not.toContain(token);
    }
  });

  it("appends extra args after the managed arguments", () => {
    const config = buildArcLaunchConfig({
      executablePath: path.resolve("C:\\Arc\\Arc.exe"),
      profilePath: path.resolve("C:\\arc-mcp-data\\profile"),
      debugPort: 9333,
      extraArgs: ["--no-first-run"],
    });
    expect(config.args).toHaveLength(4);
    expect(config.args[3]).toBe("--no-first-run");
  });

  it("rejects an out-of-range debug port with a typed error", () => {
    expect(() =>
      buildArcLaunchConfig({
        executablePath: path.resolve("C:\\Arc\\Arc.exe"),
        profilePath: path.resolve("C:\\arc-mcp-data\\profile"),
        debugPort: 99999,
      }),
    ).toThrow(ConfigError);
  });

  it("uses the stable absolute default profile for --user-data-dir", () => {
    const profile = resolveMcpProfilePath(undefined);
    expect(path.isAbsolute(profile)).toBe(true);
    const config = buildArcLaunchConfig({
      executablePath: path.resolve("C:\\Arc\\Arc.exe"),
      profilePath: profile,
      debugPort: 9222,
    });
    expect(config.profilePath).toBe(profile);
    expect(config.args[0]).toBe(`--user-data-dir=${profile}`);
  });

  it("rejects a profile inside the executable directory", () => {
    const exe = path.resolve("C:\\Arc\\Arc.exe");
    expect(() =>
      buildArcLaunchConfig({
        executablePath: exe,
        profilePath: path.join(path.dirname(exe), "profile"),
        debugPort: 9222,
      }),
    ).toThrow(ArcError);
  });
});
