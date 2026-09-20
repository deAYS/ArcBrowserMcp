import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import { cdpConnectFailed, cdpNoContext } from "../../errors/ArcError.js";
import { CDP_LOOPBACK_HOST } from "./CdpReadiness.js";

export interface CdpConnectionDeps {
  readonly connectOverCDP?: (endpoint: string) => Promise<Browser>;
}

/**
 * Playwright CDP attachment for one dedicated Arc instance.
 *
 * Playwright types never leave this module: consumers see only connection
 * state, context counts, and typed errors. No tabs/pages are created here.
 */
export class CdpConnection {
  private browser: Browser | null = null;
  private observedContexts = 0;
  private readonly disconnectedListeners: Array<() => void> = [];

  constructor(private readonly deps: CdpConnectionDeps = {}) {}

  static endpointFor(port: number): string {
    return `http://${CDP_LOOPBACK_HOST}:${String(port)}/json/version`;
  }

  static attachEndpointFor(port: number): string {
    return `http://${CDP_LOOPBACK_HOST}:${String(port)}`;
  }

  onDisconnected(listener: () => void): void {
    this.disconnectedListeners.push(listener);
  }

  private notifyDisconnected(): void {
    this.browser = null;
    const listeners = this.disconnectedListeners.splice(0, this.disconnectedListeners.length);
    for (const listener of listeners) {
      listener();
    }
  }

  async connect(port: number): Promise<void> {
    const endpoint = CdpConnection.attachEndpointFor(port);
    const connect = this.deps.connectOverCDP ?? ((url: string) => chromium.connectOverCDP(url));
    let browser: Browser;
    try {
      browser = await connect(endpoint);
    } catch (error: unknown) {
      throw cdpConnectFailed(endpoint, error);
    }
    if (!browser.isConnected()) {
      await CdpConnection.releaseBrowser(browser);
      throw cdpConnectFailed(endpoint);
    }
    browser.on("disconnected", () => this.notifyDisconnected());
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      await CdpConnection.releaseBrowser(browser);
      this.notifyDisconnected();
      throw cdpNoContext();
    }
    this.browser = browser;
    this.observedContexts = contexts.length;
  }

  private static async releaseBrowser(browser: Browser): Promise<void> {
    try {
      await browser.close();
    } catch {
      // Connection already dead; nothing left to release.
    }
  }

  isConnected(): boolean {
    return this.browser?.isConnected() ?? false;
  }

  contextCount(): number {
    return this.isConnected() ? this.observedContexts : 0;
  }

  /**
   * Ask the owned browser to close itself via CDP (Browser.close) and wait
   * for the disconnect, bounded. Returns true when the browser went away.
   */
  async gracefulBrowserClose(timeoutMs = 10_000): Promise<boolean> {
    const browser = this.browser;
    if (browser === null || !browser.isConnected()) {
      return true;
    }
    const closed = new Promise<void>((resolve) => {
      const handler = (): void => {
        browser.off("disconnected", handler);
        resolve();
      };
      browser.on("disconnected", handler);
    });
    try {
      const session = await browser.newBrowserCDPSession();
      await session.send("Browser.close");
    } catch {
      return false;
    }
    const outcome = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    return outcome;
  }

  /** Release Playwright resources without killing anything. */
  async release(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (browser !== null) {
      await CdpConnection.releaseBrowser(browser);
    }
  }
}
