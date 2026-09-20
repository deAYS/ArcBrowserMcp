import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { ArcError } from "../src/errors/ArcError.js";
import type { AppxPackageInfo, DiscoveryProbes } from "../src/browser/arc/ArcDiscovery.js";
import { discoverArcExecutable } from "../src/browser/arc/ArcDiscovery.js";

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
    readRunningArcPaths: async (): Promise<string[]> => {
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

describe("explicit arcExecutablePath override", () => {
  it("valid explicit path wins without touching auto-discovery", async () => {
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
    const result = await discoverArcExecutable({ explicitPath: exe, probes });
    expect(result.source).toBe("explicit");
    expect(result.executablePath).toBe(exe);
    expect(calls.appx).toBe(0);
    expect(calls.processes).toBe(0);
    expect(calls.aliases).toBe(0);
  });

  it("explicit path with wrong basename returns typed invalid-path error", async () => {
    const error = await captureCode(() =>
      discoverArcExecutable({
        explicitPath: path.resolve("C:\\Tools\\chrome.exe"),
        probes: fakeProbes(),
      }),
    );
    expect(error).toBeInstanceOf(ArcError);
    expect((error as ArcError).code).toBe("ARC_EXECUTABLE_PATH_INVALID");
  });

  it("missing explicit file returns typed error and never falls back to auto-discovery", async () => {
    const calls = freshCalls();
    const error = await captureCode(() =>
      discoverArcExecutable({
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
    expect(error).toBeInstanceOf(ArcError);
    expect((error as ArcError).code).toBe("ARC_EXECUTABLE_PATH_INVALID");
    expect(calls.appx).toBe(0);
    expect(calls.processes).toBe(0);
  });
});

describe("auto-discovery strategies", () => {
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
    const result = await discoverArcExecutable({ probes });
    expect(result.source).toBe("appx-package");
    expect(result.executablePath).toBe(path.resolve(expected));
    expect(result.packageVersion).toBe("1.2.3.4");
  });

  it("deduplicates running-process paths and skips non-Arc basenames", async () => {
    const exe = path.resolve("D:\\Apps\\Arc\\Arc.exe");
    const probes = fakeProbes({
      isExecutableFile: async (p: string) => p.toLowerCase() === exe.toLowerCase(),
      readRunningArcPaths: async (): Promise<string[]> => [exe, exe.toUpperCase(), "D:\\Apps\\Arc\\helper.exe"],
    });
    const result = await discoverArcExecutable({ probes });
    expect(result.source).toBe("running-process");
    expect(result.executablePath).toBe(exe);
  });

  it("probe exceptions fall through instead of crashing discovery", async () => {
    const probes = fakeProbes({
      readRunningArcPaths: async (): Promise<string[]> => {
        throw new Error("access denied");
      },
      queryAppxPackage: async (): Promise<AppxPackageInfo | null> => {
        throw new SyntaxError("unexpected token in JSON");
      },
    });
    const error = await captureCode(() => discoverArcExecutable({ probes }));
    expect(error).toBeInstanceOf(ArcError);
    expect((error as ArcError).code).toBe("ARC_EXECUTABLE_NOT_FOUND");
  });

  it("execution alias is used only as a last resort", async () => {
    const alias = path.resolve("C:\\Users\\someone\\AppData\\Local\\Microsoft\\WindowsApps\\Arc.exe");
    const probes = fakeProbes({
      isExecutableFile: async (p: string) => p.toLowerCase() === alias.toLowerCase(),
      executionAliasCandidates: (): string[] => [alias],
    });
    const result = await discoverArcExecutable({ probes });
    expect(result.source).toBe("execution-alias");
    expect(result.executablePath).toBe(alias);
  });
});

describe("candidate validation and not-found", () => {
  it("rejects a directory pretending to be Arc.exe", async () => {
    const probes = fakeProbes({
      readRunningArcPaths: async (): Promise<string[]> => [path.resolve("D:\\Apps\\Arc.exe")],
    });
    const error = await captureCode(() => discoverArcExecutable({ probes }));
    expect(error).toBeInstanceOf(ArcError);
    expect((error as ArcError).code).toBe("ARC_EXECUTABLE_NOT_FOUND");
  });

  it("exhausted strategies return typed not-found with override remediation", async () => {
    const error = await captureCode(() => discoverArcExecutable({ probes: fakeProbes() }));
    expect(error).toBeInstanceOf(ArcError);
    expect((error as ArcError).code).toBe("ARC_EXECUTABLE_NOT_FOUND");
    expect((error as ArcError).message).toContain("ARC_MCP_ARC_EXECUTABLE_PATH");
    expect((error as ArcError).details["strategiesTried"]).toContain("appx-package");
  });
});
