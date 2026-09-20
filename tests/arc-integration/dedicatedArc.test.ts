import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverArcExecutable } from "../../src/browser/arc/ArcDiscovery.js";
import { resolveMcpProfilePath } from "../../src/browser/arc/ArcProfile.js";
import { CdpBrowserEngine } from "../../src/browser/cdp/CdpBrowserEngine.js";
import { cdpVersionUrl } from "../../src/browser/cdp/CdpReadiness.js";

/**
 * Real Windows Arc integration. Explicit opt-in via `pnpm test:arc`;
 * never runs under plain `pnpm test`.
 *
 * Uses a temporary per-run profile under os.tmpdir() and an ephemeral
 * loopback port. Never touches %LOCALAPPDATA%\\arc-mcp\\profile or the
 * user's normal Arc profile. Only terminates the Arc instance this test
 * launched; pre-existing Arc processes must remain alive.
 */

const PROBE_TIMEOUT_MS = 30_000;

function runPowerShell(script: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error instanceof Error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Read-only snapshot of running Arc PIDs for later no-harm verification. */
async function runningArcPids(): Promise<number[]> {
  const output = await runPowerShell(
    "Get-Process -Name 'Arc' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
  );
  return output
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid));
}

/** Read-only command line of one PID (ownership/isolation evidence only). */
async function processCommandLine(pid: number): Promise<string> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`refusing to query non-pid value ${String(pid)}`);
  }
  const output = await runPowerShell(
    `Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}" | Select-Object -ExpandProperty CommandLine`,
  );
  return output.trim();
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ephemeralLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to allocate an ephemeral port");
  }
  const port = address.port;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

interface JsonVersion {
  readonly browser: string;
  readonly protocol: string;
}

async function fetchJsonVersion(port: number): Promise<JsonVersion> {
  const response = await fetch(cdpVersionUrl(port), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`unexpected HTTP ${String(response.status)} from /json/version`);
  }
  const payload = (await response.json()) as { Browser?: unknown; "Protocol-Version"?: unknown };
  if (typeof payload.Browser !== "string" || typeof payload["Protocol-Version"] !== "string") {
    throw new Error("malformed /json/version payload");
  }
  return { browser: payload.Browser, protocol: payload["Protocol-Version"] };
}

let ownedEngine: CdpBrowserEngine | null = null;
let tempProfile: string | null = null;

afterAll(async () => {
  // Best-effort cleanup so a failed assertion cannot orphan a test browser.
  // Uses only owned-instance lifecycle; never touches other processes.
  if (ownedEngine !== null) {
    try {
      await ownedEngine.disconnect();
    } catch (error: unknown) {
      process.stderr.write(`arc-integration cleanup disconnect failed: ${String(error)}\n`);
    }
    ownedEngine = null;
  }
  if (tempProfile !== null) {
    try {
      await rm(tempProfile, { recursive: true, force: true });
    } catch (error: unknown) {
      process.stderr.write(`arc-integration cleanup rm failed: ${String(error)}\n`);
    }
    tempProfile = null;
  }
});

describe("real dedicated Arc over CDP", () => {
  it(
    "discovers, launches isolated Arc, connects, verifies, and shuts down cleanly",
    async () => {
      const preexistingPids = await runningArcPids();

      const discovery = await discoverArcExecutable({});
      const port = await ephemeralLoopbackPort();
      tempProfile = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-test-"));

      // Never the persistent production profile, never the normal profile.
      expect(path.resolve(tempProfile)).not.toBe(resolveMcpProfilePath(undefined));

      const engine = new CdpBrowserEngine(
        {
          executablePath: discovery.executablePath,
          profilePath: tempProfile,
          debugPort: port,
          readinessTimeoutMs: 90_000,
        },
      );
      ownedEngine = engine;
      expect((await engine.status()).state).toBe("disconnected");

      await engine.connect();
      const ownedPid = engine.getOwnedPid();
      expect(ownedPid).not.toBeNull();

      // CDP reachable on loopback with usable version metadata.
      expect(cdpVersionUrl(port).startsWith("http://127.0.0.1:")).toBe(true);
      const version = await fetchJsonVersion(port);

      const status = await engine.status();
      expect(status.connected).toBe(true);
      expect(status.state).toBe("connected");
      expect(status.backend).toBe("cdp");
      expect(status.cdpPort).toBe(port);
      expect(status.discoverySource).toBe(discovery.source);
      expect(status.selectedTabId).toBeNull();
      expect(status.contextCount ?? 0).toBeGreaterThanOrEqual(1);

      // Profile isolation: owned command line carries the test profile...
      if (ownedPid !== null) {
        const commandLine = await processCommandLine(ownedPid);
        expect(commandLine).toContain(`--user-data-dir=${tempProfile}`);
      }
      // ...and the test profile directory received real browser state.
      const entries = await readdir(tempProfile);
      expect(entries.length).toBeGreaterThan(0);

      // Clean shutdown of the owned instance only.
      await engine.disconnect();
      ownedEngine = null;
      expect((await engine.status()).connected).toBe(false);
      if (ownedPid !== null) {
        expect(pidAlive(ownedPid)).toBe(false);
      }

      // Pre-existing unrelated Arc processes must remain alive.
      for (const pid of preexistingPids) {
        expect(pidAlive(pid), `pre-existing Arc pid ${String(pid)} must survive`).toBe(true);
      }

      // Remove the temporary test profile only after the owned exit.
      await rm(tempProfile, { recursive: true, force: true });
      tempProfile = null;

      process.stderr.write(
        `arc-integration evidence: strategy=${discovery.source} port=${String(port)} ` +
          `browser=${version.browser} protocol=${version.protocol} ` +
          `contexts=${String(status.contextCount ?? 0)} ownedPid=${String(ownedPid)} ` +
          `preexisting=${preexistingPids.join(",")}\n`,
      );
    },
    180_000,
  );
});
