import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, parseLogLevel } from "../src/utils/logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger", () => {
  it("writes diagnostics to stderr only, never stdout", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const logger = createLogger("info");
    logger.info("hello baseline", { debugPort: 9222 });

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = String(stderrSpy.mock.calls[0]?.[0] ?? "");
    expect(written).toContain('"level":"info"');
    expect(written).toContain("hello baseline");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("respects the configured minimum level", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const logger = createLogger("warn");
    logger.debug("suppressed");
    logger.info("suppressed");
    expect(stderrSpy).not.toHaveBeenCalled();

    logger.warn("visible");
    logger.error("visible");
    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });
});

describe("parseLogLevel", () => {
  it("accepts known levels and rejects unknown values", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("bogus")).toBeUndefined();
    expect(parseLogLevel(undefined)).toBeUndefined();
  });
});
