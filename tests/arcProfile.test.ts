import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ArcError } from "../src/errors/ArcError.js";
import { ConfigError } from "../src/config/config.js";
import {
  assertSafeProfilePath,
  defaultMcpProfilePath,
  resolveMcpProfilePath,
  resolveProfilePath,
} from "../src/browser/arc/ArcProfile.js";

function expectUnsafe(target: string, arcInstallDirs: readonly string[] = []): void {
  expect(() => assertSafeProfilePath(path.resolve(target), { arcInstallDirs })).toThrow(ArcError);
  try {
    assertSafeProfilePath(path.resolve(target), { arcInstallDirs });
  } catch (error: unknown) {
    expect((error as ArcError).code).toBe("ARC_PROFILE_PATH_UNSAFE");
  }
}

describe("stable per-user default profile", () => {
  it("resolves %LOCALAPPDATA%\\arc-mcp\\profile and is absolute", () => {
    const resolved = resolveMcpProfilePath(undefined, {
      LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
    });
    expect(resolved).toBe(path.join("C:\\Users\\someone\\AppData\\Local", "arc-mcp", "profile"));
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it("does not depend on process.cwd()", () => {
    const previousCwd = process.cwd();
    try {
      process.chdir(os.tmpdir());
      const fromTmp = resolveMcpProfilePath(undefined);
      const home = process.env["USERPROFILE"] ?? os.homedir();
      process.chdir(home);
      const fromHome = resolveMcpProfilePath(undefined);
      expect(fromTmp).toBe(fromHome);
      expect(path.isAbsolute(fromTmp)).toBe(true);
      expect(() => assertSafeProfilePath(fromTmp)).not.toThrow();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("real-machine default is outside every forbidden tree", () => {
    const resolved = resolveMcpProfilePath(undefined);
    const lower = resolved.toLowerCase();
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(lower).not.toContain("windowsapps");
    expect(lower).not.toContain(`${path.sep}packages${path.sep}`);
    expect(() => assertSafeProfilePath(resolved)).not.toThrow();
  });

  it("falls back to USERPROFILE AppData when LOCALAPPDATA is missing", () => {
    const resolved = resolveMcpProfilePath(undefined, {
      LOCALAPPDATA: "",
      USERPROFILE: "C:\\Users\\someone",
    });
    expect(resolved).toBe(
      path.join("C:\\Users\\someone", "AppData", "Local", "arc-mcp", "profile"),
    );
  });

  it("throws a typed error when no per-user base exists instead of using CWD", () => {
    expect(() => defaultMcpProfilePath({})).toThrow(ConfigError);
    expect(() => resolveMcpProfilePath(undefined, {})).toThrow(ConfigError);
    // An empty override is treated as absent and resolves the default.
    expect(
      resolveMcpProfilePath("", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }),
    ).toBe(path.join("C:\\Users\\x\\AppData\\Local", "arc-mcp", "profile"));
  });

  it("never rewrites an explicit override into the default location", () => {
    const explicit = "C:\\custom\\mcp-profile";
    const resolved = resolveMcpProfilePath(explicit, {
      LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
    });
    expect(resolved).toBe(path.resolve(explicit));
    expect(resolved).not.toBe(defaultMcpProfilePath({ LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" }));
  });

  it("explicit relative override still resolves against CWD by caller choice", () => {
    expect(resolveProfilePath("relative-dir")).toBe(path.resolve("relative-dir"));
  });
});

describe("profile safety validation", () => {
  it("rejects filesystem roots", () => {
    expectUnsafe(path.parse(process.cwd()).root);
  });

  it("rejects Windows system and package locations", () => {
    const windir = process.env["SystemRoot"] ?? process.env["WINDIR"];
    if (windir !== undefined && windir !== "") {
      expectUnsafe(windir);
      expectUnsafe(path.join(windir, "System32"));
    }
    const localAppData = process.env["LOCALAPPDATA"];
    if (localAppData !== undefined && localAppData !== "") {
      expectUnsafe(path.join(localAppData, "Packages", "TheBrowserCompany.Arc_ttt1ap7aakyb4"));
    }
    const programFiles = process.env["ProgramFiles"];
    if (programFiles !== undefined && programFiles !== "") {
      expectUnsafe(path.join(programFiles, "WindowsApps", "TheBrowserCompany.Arc_1.0_x64__ttt1ap7aakyb4"));
    }
  });

  it("rejects targets inside known Arc install locations regardless of case", () => {
    const installDir = "C:\\Program Files\\WindowsApps\\TheBrowserCompany.Arc_1.2.3.4_x64__ttt1ap7aakyb4";
    expectUnsafe(path.join(installDir, "profile"), [installDir]);
    expectUnsafe(path.join(installDir.toLowerCase(), "PROFILE"), [installDir.toUpperCase()]);
  });

  it("accepts an unrelated project-owned directory", () => {
    const target = path.resolve(path.join(process.cwd(), "data", "custom-mcp-profile"));
    expect(() => assertSafeProfilePath(target)).not.toThrow();
  });
});
