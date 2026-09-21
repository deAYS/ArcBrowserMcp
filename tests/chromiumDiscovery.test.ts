import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { BrowserError } from "../src/errors/BrowserError.js";
import type { AppxPackageInfo, DiscoveryProbes } from "../src/browser/chromium/discovery.js";
import { discoverExecutable } from "../src/browser/chromium/discovery.js";
import { arcSpec, chromeSpec } from "../src/browser/chromium/spec.js";
import type { BrowserSpec } from "../src/browser/chromium/spec.js";

interface ProbeCalls {
  files: number;
  appx: number;
  processes: number;
  aliases: number;
}

function fakeProbes(overrides: Partial<DiscoveryProbes> = {}, calls?: ProbeCalls): DiscoveryProbes {
  return {
    isExecutableFile: async (_p: string) => {
      if (calls !== undefined) {
        calls.files += 1;
      }
      return false;
    },
    queryAppxPackage: async (): Promise<AppxPackageInfo | null> => {
      if (calls !== undefined) {
        calls.appx += 1;
      }
      return null;
    },
    readRunningProcessPaths: async (): Promise<string[]> => {
      if (calls !== undefined) {
        calls.processes += 1;
      }
      return [];
    },
    executionAliasCandidates: (): string[] => {
      if (calls !== undefined) {
        calls.aliases += 1;
      }
      return [];
    },
    ...overrides,
  };
}

function freshCalls(): ProbeCalls {
  return { files: 0, appx: 0, processes: 0, aliases: 0 };
}

async function captureCode(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected action to throw");
}

describe("specs", () => {
  it("arc keeps the MSIX identity and dedicated blocked scheme", () => {
    const spec = arcSpec();
    expect(spec.id).toBe("arc");
    expect(spec.executableBasename).toBe("Arc.exe");
    expect(spec.appxPackageName).toBe("TheBrowserCompany.Arc");
    expect(spec.blockedCreateSchemes).toEqual(["arc:"]);
    expect(spec.profileDirName).toBe("profile");
  });

  it("chrome has no MSIX package but fixed install dirs and its own profile", () => {
    const spec = chromeSpec({
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
    });
    expect(spec.id).toBe("chrome");
    expect(spec.executableBasename).toBe("chrome.exe");
    expect(spec.appxPackageName).toBeNull();
    expect(spec.blockedCreateSchemes).toEqual([]);
    expect(spec.profileDirName).toBe("profile-chrome");
    expect(spec.installDirCandidates).toEqual([
      path.join("C:\\Program Files", "Google", "Chrome", "Application"),
      path.join("C:\\Program Files (x86)", "Google", "Chrome", "Application"),
      path.join("C:\\Users\\someone\\AppData\\Local", "Google", "Chrome", "Application"),
    ]);
  });

  it("browserSpec maps ids to specs", () => {
    expect(browserSpecFor("arc").id).toBe("arc");
    expect(browserSpecFor("chrome").id).toBe("chrome");
  });
});

function browserSpecFor(id: "arc" | "chrome"): BrowserSpec {
  return id === "chrome" ? chromeSpec({}) : arcSpec({});
}

describe("explicit executablePath override", () => {
  it("valid explicit path wins without touching auto-discovery (arc)", async () => {
    const calls = freshCalls();
    const exe = path.resolve("C:\\Arc\\Arc.exe");
    const probes = fakeProbes(
      {
        isExecutableFile: async (p: string) => {
          calls.files += 1;
          return p.toLowerCase() === exe.toLowerCase();
        },
        queryAppxPackage: async (): Promise<AppxPackageInfo | null> => {
          calls.appx += 1;
          return {
            name: "TheBrowserCompany.Arc",
            packageFullName: "TheBrowserCompany.Arc_9.9.9.9_x64__ttt1ap7aakyb4",
            installLocation: "C:\\Program Files\\WindowsApps\\Other",
            version: "9.9.9",
          };
        },
      },
      calls,
    );
    const result = await discoverExecutable(arcSpec({}), { explicitPath: exe, probes });
    expect(result.source).toBe("explicit");
    expect(result.executablePath).toBe(exe);
    expect(calls.appx).toBe(0);
    expect(calls.processes).toBe(0);
    expect(calls.aliases).toBe(0);
  });

  it("explicit path with wrong basename returns typed invalid-path error (chrome)", async () => {
    const error = await captureCode(() =>
      discoverExecutable(chromeSpec({}), {
        explicitPath: path.resolve("C:\\Tools\\Arc.exe"),
        probes: fakeProbes(),
      }),
    );
    expect(error).toBeInstanceOf(BrowserError);
    expect((error as BrowserError).code).toBe("BROWSER_EXECUTABLE_PATH_INVALID");
  });

  it("missing explicit file returns typed error and never falls back to auto-discovery", async () => {
    const calls = freshCalls();
    const error = await captureCode(() =>
      discoverExecutable(arcSpec({}), {
        explicitPath: path.resolve("C:\\Arc\\Arc.exe"),
        probes: fakeProbes(
          {
            queryAppxPackage: async (): Promise<AppxPackageInfo | null> => {
              calls.appx += 1;
              return {
                name: "TheBrowserCompany.Arc",
                packageFullName: "pkg",
                installLocation: "C:\\Somewhere",
                version: "1.0",
              };
            },
          },
          calls,
        ),
      }),
    );
    expect(error).toBeInstanceOf(BrowserError);
    expect((error as BrowserError).code).toBe("BROWSER_EXECUTABLE_PATH_INVALID");
    expect(calls.appx).toBe(0);
    expect(calls.processes).toBe(0);
  });
});

describe("auto-discovery strategies (arc)", () => {
  it("resolves <InstallLocation>\\Arc.exe from AppX metadata dynamically", async () => {
    const installLocation = "C:\\Program Files\\WindowsApps\\TheBrowserCompany.Arc_1.2.3.4_x64__ttt1ap7aakyb4";
    const expected = path.join(installLocation, "Arc.exe");
    const probes = fakeProbes({
      isExecutableFile: async (p: string) => p.toLowerCase() === expected.toLowerCase(),
      queryAppxPackage: async (): Promise<AppxPackageInfo | null> => ({
        name: "TheBrowserCompany.Arc",
        packageFullName: "TheBrowserCompany.Arc_1.2.3.4_x64__ttt1ap7aakyb4",
        installLocation,
        version: "1.2.3.4",
      }),
    });
    const result = await discoverExecutable(arcSpec({}), { probes });
    expect(result.source).toBe("appx-package");
    expect(result.executablePath).toBe(path.resolve(expected));
    expect(result.packageVersion).toBe("1.2.3.4");
  });

  it("deduplicates running-process paths and skips non-matching basenames", async () => {
    const exe = path.resolve("D:\\Apps\\Arc\\Arc.exe");
    const probes = fakeProbes({
      isExecutableFile: async (p: string) => p.toLowerCase() === exe.toLowerCase(),
      readRunningProcessPaths: async (): Promise<string[]> => [exe, exe.toUpperCase(), "D:\\Apps\\Arc\\helper.exe"],
    });
    const result = await discoverExecutable(arcSpec({}), { probes });
    expect(result.source).toBe("running-process");
    expect(result.executablePath).toBe(exe);
  });

  it("probe exceptions fall through instead of crashing discovery", async () => {
    const probes = fakeProbes({
      readRunningProcessPaths: async (): Promise<string[]> => {
        throw new Error("access denied");
      },
      queryAppxPackage: async (): Promise<AppxPackageInfo | null> => {
        throw new SyntaxError("unexpected token in JSON");
      },
    });
    const error = await captureCode(() => discoverExecutable(arcSpec({}), { probes }));
    expect(error).toBeInstanceOf(BrowserError);
    expect((error as BrowserError).code).toBe("BROWSER_EXECUTABLE_NOT_FOUND");
  });

  it("execution alias is used only as a last resort", async () => {
    const alias = path.resolve("C:\\Users\\someone\\AppData\\Local\\Microsoft\\WindowsApps\\Arc.exe");
    const probes = fakeProbes({
      isExecutableFile: async (p: string) => p.toLowerCase() === alias.toLowerCase(),
      executionAliasCandidates: (): string[] => [alias],
    });
    const result = await discoverExecutable(arcSpec({}), { probes });
    expect(result.source).toBe("execution-alias");
    expect(result.executablePath).toBe(alias);
  });
});

describe("auto-discovery strategies (chrome)", () => {
  it("skips the MSIX probe entirely and resolves the first install dir", async () => {
    const calls = freshCalls();
    const dirA = "C:\\Program Files\\Google\\Chrome\\Application";
    const expected = path.join(dirA, "chrome.exe");
    const spec: BrowserSpec = {
      ...chromeSpec({ ProgramFiles: dirA }),
    };
    const probes = fakeProbes(
      {
        isExecutableFile: async (p: string) => {
          calls.files += 1;
          return p.toLowerCase() === expected.toLowerCase();
        },
      },
      calls,
    );
    const result = await discoverExecutable(spec, { probes });
    expect(result.source).toBe("install-dir");
    expect(result.executablePath).toBe(path.resolve(expected));
    expect(calls.appx).toBe(0);
  });

  it("fall back to later install dirs, then alias, before giving up", async () => {
    const alias = path.resolve("C:\\Users\\someone\\AppData\\Local\\Microsoft\\WindowsApps\\chrome.exe");
    const dirB = "C:\\Program Files (x86)\\Google\\Chrome\\Application";
    const spec: BrowserSpec = {
      ...chromeSpec({ "ProgramFiles(x86)": dirB, LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" }),
      installDirCandidates: ["C:\\Missing\\Chrome\\Application", dirB],
    };
    const probes = fakeProbes({
      isExecutableFile: async (p: string) => p.toLowerCase() === alias.toLowerCase(),
      executionAliasCandidates: (): string[] => [alias],
    });
    const result = await discoverExecutable(spec, { probes });
    expect(result.source).toBe("execution-alias");
    expect(result.executablePath).toBe(path.resolve(alias));
  });

  it("running chrome process wins over install dirs", async () => {
    const exe = path.resolve("D:\\Chrome\\chrome.exe");
    const spec = chromeSpec({ ProgramFiles: "C:\\Program Files" });
    const probes = fakeProbes({
      isExecutableFile: async (p: string) => p.toLowerCase() === exe.toLowerCase(),
      readRunningProcessPaths: async (): Promise<string[]> => [exe],
    });
    const result = await discoverExecutable(spec, { probes });
    expect(result.source).toBe("running-process");
    expect(result.executablePath).toBe(exe);
  });

  it("exhausted strategies name Google Chrome and the override env var", async () => {
    const error = await captureCode(() =>
      discoverExecutable(chromeSpec({ ProgramFiles: "C:\\Program Files" }), { probes: fakeProbes() }),
    );
    expect(error).toBeInstanceOf(BrowserError);
    expect((error as BrowserError).code).toBe("BROWSER_EXECUTABLE_NOT_FOUND");
    expect((error as BrowserError).message).toContain("Google Chrome");
    expect((error as BrowserError).message).toContain("ARC_MCP_EXECUTABLE_PATH");
    expect((error as BrowserError).details["strategiesTried"]).toContain("install-dir");
  });
});

describe("candidate validation and not-found (arc)", () => {
  it("rejects a directory pretending to be Arc.exe", async () => {
    const probes = fakeProbes({
      readRunningProcessPaths: async (): Promise<string[]> => [path.resolve("D:\\Apps\\Arc.exe")],
    });
    const error = await captureCode(() => discoverExecutable(arcSpec({}), { probes }));
    expect(error).toBeInstanceOf(BrowserError);
    expect((error as BrowserError).code).toBe("BROWSER_EXECUTABLE_NOT_FOUND");
  });

  it("exhausted strategies return typed not-found with override remediation", async () => {
    const error = await captureCode(() => discoverExecutable(arcSpec({}), { probes: fakeProbes() }));
    expect(error).toBeInstanceOf(BrowserError);
    expect((error as BrowserError).code).toBe("BROWSER_EXECUTABLE_NOT_FOUND");
    expect((error as BrowserError).message).toContain("ARC_MCP_EXECUTABLE_PATH");
    expect((error as BrowserError).details["strategiesTried"]).toContain("appx-package");
  });
});
