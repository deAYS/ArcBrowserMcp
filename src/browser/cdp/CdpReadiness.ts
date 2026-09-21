import * as net from "node:net";
import { processExitedEarly, cdpReadyTimeout } from "../../errors/BrowserError.js";

export const CDP_LOOPBACK_HOST = "127.0.0.1";

export interface CdpVersionInfo {
  readonly browser: string;
  readonly protocolVersion: string;
  readonly webSocketDebuggerUrl: string;
}

export interface CdpFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type CdpFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<CdpFetchResponse>;

export interface CdpReadinessOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly perRequestTimeoutMs: number;
  /** Returns false when the owned process is gone; aborts with early-exit. */
  readonly isAlive?: () => boolean;
  /** Human-readable exit description used for the early-exit error. */
  readonly describeExit?: () => string;
  readonly fetchImpl?: CdpFetch;
}

export const DEFAULT_READINESS_OPTIONS = {
  timeoutMs: 60_000,
  intervalMs: 250,
  perRequestTimeoutMs: 5_000,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toVersionInfo(value: unknown): CdpVersionInfo | null {
  if (!isRecord(value)) {
    return null;
  }
  const browser = value["Browser"];
  const protocolVersion = value["Protocol-Version"];
  const webSocketDebuggerUrl = value["webSocketDebuggerUrl"];
  if (
    typeof browser !== "string" ||
    browser === "" ||
    typeof protocolVersion !== "string" ||
    protocolVersion === "" ||
    typeof webSocketDebuggerUrl !== "string" ||
    webSocketDebuggerUrl === ""
  ) {
    return null;
  }
  return { browser, protocolVersion, webSocketDebuggerUrl };
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** True when something already listens on host:port (short bounded probe). */
export function isTcpPortOccupied(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (occupied: boolean): void => {
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export function cdpVersionUrl(port: number): string {
  return `http://${CDP_LOOPBACK_HOST}:${String(port)}/json/version`;
}

/**
 * Poll /json/version until usable CDP metadata appears. TCP-open alone is
 * not sufficient. Throws BROWSER_CDP_READY_TIMEOUT when the bound expires.
 * Never throws for transient probe failures; the last error is reported.
 */
export async function waitForCdpReady(
  port: number,
  options: CdpReadinessOptions = DEFAULT_READINESS_OPTIONS,
): Promise<CdpVersionInfo> {
  const defaultFetch: CdpFetch = (url, init) => fetch(url, init);
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const deadline = Date.now() + options.timeoutMs;
  let lastError = "no probe attempted";
  for (;;) {
    if (options.isAlive !== undefined && !options.isAlive()) {
      throw processExitedEarly(port, options.describeExit?.() ?? "exit status unknown");
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.perRequestTimeoutMs);
      try {
        const response = await fetchImpl(cdpVersionUrl(port), { signal: controller.signal });
        if (response.ok) {
          const info = toVersionInfo(await response.json());
          if (info !== null) {
            return info;
          }
          lastError = "malformed /json/version response";
        } else {
          lastError = `HTTP ${String(response.status)} from /json/version`;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error: unknown) {
      // Expected while the browser starts (refused/timeout/abort): keep polling.
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw cdpReadyTimeout(port, options.timeoutMs, lastError);
    }
    const remaining = deadline - Date.now();
    await delay(Math.min(options.intervalMs, Math.max(remaining, 0)));
  }
}
