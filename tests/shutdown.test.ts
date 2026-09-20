import { afterEach, describe, expect, it, vi } from "vitest";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createShutdownHandler } from "../src/server/transport.js";
import { createLogger } from "../src/utils/logger.js";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function stubHandle(impl?: () => Promise<void>): { handle: StdioServerHandle; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    handle: {
      async close(): Promise<void> {
        calls += 1;
        if (impl !== undefined) {
          await impl();
        }
      },
    },
  };
}

describe("createShutdownHandler", () => {
  it("closes the server handle exactly once across repeated signals", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stub = stubHandle();
    const shutdown = createShutdownHandler(stub.handle, createLogger("info"));

    shutdown("SIGINT");
    shutdown("SIGINT");
    shutdown("SIGTERM");

    await vi.waitFor(() => expect(stub.calls()).toBe(1));
    expect(stub.calls()).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("sets a non-zero exit code when handle.close() rejects", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stub = stubHandle(() => Promise.reject(new Error("boom")));
    const shutdown = createShutdownHandler(stub.handle, createLogger("info"));

    shutdown("SIGTERM");

    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(stub.calls()).toBe(1);
  });
});
