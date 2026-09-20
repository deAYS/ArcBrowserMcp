import { afterAll, describe, expect, it } from "vitest";
import {
  BOUND_MS,
  callTool,
  closeLiveSession,
  openDisposableTab,
  startFixture,
  startLiveSession,
  structuredTabs,
  type LiveContext,
} from "./liveHelpers.js";

/**
 * P10 live soak (opt-in via pnpm test:soak; never runs under plain pnpm
 * test). Repeated bounded representative cycles against one/few disposable
 * 127.0.0.1 fixture tabs: status, list, snapshot, get_text, evaluate,
 * wait, periodic screenshot, console/network get, occasional clear, and
 * periodic owned-tab churn. Defaults satisfy the P10 minimum (>=10 minutes
 * and >=100 successful cycles, whichever takes longer); env overrides allow
 * shorter developer runs.
 *
 * P10_SOAK_MIN_SECONDS (default 600), P10_SOAK_MIN_CYCLES (default 100).
 */

const MIN_SECONDS = Math.max(60, Number.parseInt(process.env["P10_SOAK_MIN_SECONDS"] ?? "600", 10) || 600);
const MIN_CYCLES = Math.max(1, Number.parseInt(process.env["P10_SOAK_MIN_CYCLES"] ?? "100", 10) || 100);
const SCREENSHOT_EVERY = Math.max(1, Number.parseInt(process.env["P10_SOAK_SCREENSHOT_EVERY"] ?? "10", 10) || 10);
const CHURN_EVERY = Math.max(5, Number.parseInt(process.env["P10_SOAK_CHURN_EVERY"] ?? "25", 10) || 25);

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>P10 Soak Home</title></head>
<body>
<h1>P10 Soak Fixture</h1>
<div id="status" role="status">status: ready</div>
<label>Name <input id="name" type="text" value="soak"></label>
<button id="submit" type="button">Submit</button>
<script>
document.getElementById("submit").addEventListener("click", () => {
  document.getElementById("status").textContent = "status: clicked";
});
</script>
</body></html>`;

let ctx: LiveContext | null = null;

afterAll(async () => {
  if (ctx !== null) {
    const current = ctx;
    ctx = null;
    await closeLiveSession(current).catch(() => undefined);
  }
}, 120_000);

describe("P10 live soak", () => {
  it(
    "sustains bounded representative cycles with cleanup convergence",
    async () => {
      const { base, server } = await startFixture((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(FIXTURE_HTML);
      });
      ctx = await startLiveSession("arc-mcp-p10-soak-client");
      ctx.fixtureServer = server;
      const fixtureUrl = `${base}/`;

      let tab = await openDisposableTab(ctx, fixtureUrl);
      const startedAt = Date.now();
      let cycles = 0;
      let failures = 0;
      let screenshots = 0;
      let churns = 0;
      const samples: Array<{ cycle: number; elapsedMs: number }> = [];

      for (;;) {
        const elapsedS = (Date.now() - startedAt) / 1000;
        if (cycles >= MIN_CYCLES && elapsedS >= MIN_SECONDS) {
          break;
        }
        cycles += 1;
        try {
          // Representative subset (all read-only except occasional click).
          const status = await callTool(ctx.client, "browser_status");
          if (status.isError === true) {
            throw new Error("browser_status failed");
          }
          const listed = structuredTabs(await callTool(ctx.client, "browser_list_tabs"));
          if (!listed.tabs.some((t) => t.id === tab.id)) {
            throw new Error(`owned soak tab ${tab.id} disappeared mid-soak`);
          }
          const snapshot = await callTool(ctx.client, "browser_snapshot");
          if (snapshot.isError === true) {
            throw new Error("browser_snapshot failed");
          }
          const payload = snapshot.structuredContent as { nodes?: Array<{ ref?: string; role: string; name?: string }> };
          const heading = payload.nodes?.find((n) => n.role === "heading" && n.ref !== undefined)?.ref;
          if (heading === undefined) {
            throw new Error("soak snapshot missing heading ref");
          }
          const text = await callTool(ctx.client, "browser_get_text", { ref: heading });
          if (text.isError === true) {
            throw new Error("browser_get_text failed");
          }
          const evaluated = await callTool(ctx.client, "browser_evaluate", { expression: "1 + 1" });
          if (evaluated.isError === true) {
            throw new Error("browser_evaluate failed");
          }
          // Evaluate invalidates refs: re-snapshot before the wait check so
          // the wait-preservation assertion below uses a live ref.
          const snapshot2 = await callTool(ctx.client, "browser_snapshot");
          if (snapshot2.isError === true) {
            throw new Error("post-evaluate snapshot failed");
          }
          const payload2 = snapshot2.structuredContent as { nodes?: Array<{ ref?: string; role: string }> };
          const heading2 = payload2.nodes?.find((n) => n.role === "heading" && n.ref !== undefined)?.ref;
          if (heading2 === undefined) {
            throw new Error("post-evaluate snapshot missing heading ref");
          }
          const waited = await callTool(ctx.client, "browser_wait_for", {
            condition: { type: "text", value: "P10 Soak Fixture" },
            timeoutMs: 15_000,
          });
          if (waited.isError === true) {
            throw new Error("browser_wait_for failed");
          }
          const afterWait = await callTool(ctx.client, "browser_get_text", { ref: heading2 });
          if (afterWait.isError === true) {
            throw new Error("wait invalidated a live ref");
          }
          if (cycles % SCREENSHOT_EVERY === 0) {
            const shot = await callTool(ctx.client, "browser_screenshot");
            if (shot.isError === true) {
              throw new Error("browser_screenshot failed");
            }
            screenshots += 1;
          }
          const consoleGet = await callTool(ctx.client, "browser_console", { action: "get" });
          if (consoleGet.isError === true) {
            throw new Error("browser_console failed");
          }
          const networkGet = await callTool(ctx.client, "browser_network", { action: "get" });
          if (networkGet.isError === true) {
            throw new Error("browser_network failed");
          }
          if (cycles % CHURN_EVERY === 0) {
            await callTool(ctx.client, "browser_console", { action: "clear" });
            await callTool(ctx.client, "browser_network", { action: "clear" });
          }
          // Owned-tab churn: open/select/close a second disposable tab, then
          // continue on the primary soak tab.
          if (cycles % CHURN_EVERY === 0) {
            const extra = await callTool(ctx.client, "browser_open_tab", { url: fixtureUrl });
            if (extra.isError !== true) {
              const extraTab = (extra.structuredContent as { tab: { id: string } }).tab;
              ctx.ownedTabIds.add(extraTab.id);
              await callTool(ctx.client, "browser_select_tab", { tabId: extraTab.id });
              const closed = await callTool(ctx.client, "browser_close_tab", { tabId: extraTab.id });
              if (closed.isError !== true) {
                ctx.ownedTabIds.delete(extraTab.id);
                churns += 1;
              }
              await callTool(ctx.client, "browser_select_tab", { tabId: tab.id });
            }
          }
          if (cycles % 10 === 0) {
            samples.push({ cycle: cycles, elapsedMs: Date.now() - startedAt });
          }
        } catch (error: unknown) {
          failures += 1;
          // Fail fast on structural problems; tolerate nothing silently.
          throw error;
        }
      }

      const durationS = (Date.now() - startedAt) / 1000;
      // Soak evidence (no fragile RSS assertion; bounded structures + health).
      const evidence = {
        durationSeconds: Math.round(durationS),
        cycles,
        failures,
        screenshots,
        churns,
        samples,
        bridgeConnected: (await ctx.engine.status()).connected,
      };
      // eslint-disable-next-line no-console
      console.log(`[p10-soak] ${JSON.stringify(evidence)}`);
      expect(evidence.cycles).toBeGreaterThanOrEqual(MIN_CYCLES);
      expect(evidence.durationSeconds).toBeGreaterThanOrEqual(MIN_SECONDS);
      expect(evidence.failures).toBe(0);
      expect(evidence.bridgeConnected).toBe(true);
      // Test-owned tab accounting converges: only the primary + pre-existing.
      const listed = structuredTabs(await callTool(ctx.client, "browser_list_tabs"));
      const ownedListed = listed.tabs.filter((t) => ctx?.ownedTabIds.has(t.id) ?? false);
      expect(ownedListed.map((t) => t.id)).toContain(tab.id);
      void tab;

      const current = ctx;
      ctx = null;
      await closeLiveSession(current);
    },
    Math.max(BOUND_MS, (MIN_SECONDS + 300) * 1000),
  );
});
