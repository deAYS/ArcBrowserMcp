import { afterAll, describe, expect, it } from "vitest";
import {
  BOUND_MS,
  POLL_INTERVAL_MS,
  callTool,
  closeLiveSession,
  openDisposableTab,
  startFixture,
  startLiveSession,
  type LiveContext,
} from "./liveHelpers.js";

/**
 * Controlled reconnect live test (opt-in via pnpm test:reconnect; never
 * runs under plain pnpm test). Disrupts ONLY BrowserMcp's own bridge: stops
 * the Node pipe server (the native host exits cleanly on pipe close), proves
 * status detects the loss, restarts the bridge, and proves the extension
 * reconnects without an extension reload and without touching Arc or user
 * tabs. No process killing outside BrowserMcp's own server object.
 */

let ctx: LiveContext | null = null;

afterAll(async () => {
  if (ctx !== null) {
    const current = ctx;
    ctx = null;
    await closeLiveSession(current).catch(() => undefined);
  }
}, 120_000);

describe("controlled bridge reconnect (live)", () => {
  it(
    "recovers the authoritative session after a controlled pipe restart",
    async () => {
      const { base, server } = await startFixture((req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><head><title>Reconnect</title></head><body><h1>reconnect</h1></body></html>`);
        void req;
      });
      ctx = await startLiveSession("arc-mcp-reconnect-test-client");
      ctx.fixtureServer = server;
      const opened = await openDisposableTab(ctx, `${base}/`);
      expect(opened.controllable).toBe(true);

      // Baseline: healthy connected bridge + live buildId note.
      const status0 = (await callTool(ctx.client, "browser_status")).structuredContent as { connected?: boolean };
      expect(status0.connected).toBe(true);
      const tabs0 = await callTool(ctx.client, "browser_list_tabs");
      expect(tabs0.isError).not.toBe(true);

      // Controlled interruption: stop ONLY our own Node-side bridge server.
      // The browser-launched native host sees pipe close and exits cleanly;
      // the extension schedules its bounded reconnect (timer + 1-min alarm).
      const bridgeRuntime = ctx.runtime as unknown as {
        stop(): Promise<void>;
        start(): Promise<void>;
        isRelayConnected(): boolean;
      };
      await bridgeRuntime.stop();
      // Engine status must converge to disconnected (never claim connected on
      // a dead relay object).
      {
        const deadline = Date.now() + 30_000;
        for (;;) {
          const status = (await callTool(ctx.client, "browser_status")).structuredContent as { connected?: boolean };
          if (status.connected === false) {
            break;
          }
          if (Date.now() > deadline) {
            throw new Error("status did not converge to disconnected after bridge stop");
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      }

      // Restore availability: restart our bridge; the extension reconnects
      // without a manual reload (bounded wait, polls status truthfully).
      await bridgeRuntime.start();
      {
        const deadline = Date.now() + 180_000;
        let recovered = false;
        for (;;) {
          const status = (await callTool(ctx.client, "browser_status")).structuredContent as { connected?: boolean };
          if (status.connected === true && bridgeRuntime.isRelayConnected()) {
            recovered = true;
            break;
          }
          if (Date.now() > deadline) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        expect(recovered).toBe(true);
      }

      // Post-recovery operation on the same disposable fixture succeeds; no
      // duplicate authoritative peer (a single listTabs round-trip proves the
      // session is usable exactly once).
      const tabs1 = await callTool(ctx.client, "browser_list_tabs");
      expect(tabs1.isError).not.toBe(true);
      // The previously opened disposable tab may legitimately be gone from
      // extension truth after a worker restart (epoch rotation); either it is
      // still listed or it fails closed as stale — never retargeted.
      const listed = (tabs1.structuredContent as { tabs?: Array<{ id: string }> }).tabs ?? [];
      if (listed.some((t) => t.id === opened.id)) {
        const snapshot = await callTool(ctx.client, "browser_snapshot");
        expect(snapshot.isError).not.toBe(true);
      } else {
        const select = await callTool(ctx.client, "browser_select_tab", { tabId: opened.id });
        expect(select.isError).toBe(true);
      }
      expect((await ctx.engine.status()).connected).toBe(true);

      const current = ctx;
      ctx = null;
      await closeLiveSession(current);
    },
    BOUND_MS,
  );
});
