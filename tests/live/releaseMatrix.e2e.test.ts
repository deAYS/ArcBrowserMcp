import { afterAll, describe, expect, it } from "vitest";
import { P10_FROZEN_PUBLIC_TOOLS } from "../release/toolsetSecurity.test.js";
import {
  BOUND_MS,
  POLL_INTERVAL_MS,
  callTool,
  closeLiveSession,
  openDisposableTab,
  startFixture,
  startLiveSession,
  structuredTabs,
  toolErrorCode,
  type LiveContext,
} from "./liveHelpers.js";

/**
 * P10 full release matrix over MCP (opt-in via pnpm test:release; never runs
 * under plain pnpm test). Disposable 127.0.0.1 fixture tabs only; every
 * currently registered public browser tool is exercised with cross-feature
 * semantics (refs, selection, redaction, privileged negatives). Pre-existing
 * user tabs are never observed and must survive unchanged.
 */

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>P10 Release Home</title></head>
<body>
<h1>P10 Release Fixture</h1>
<div id="status" role="status">status: ready</div>
<div id="delayed" role="status">waiting</div>
<label>Name <input id="name" type="text" value="known"></label>
<label>Secret <input id="secret" type="password" value=""></label>
<button id="trigger" type="button">Trigger observability</button>
<button id="submit" type="button">Submit</button>
<script>
document.getElementById("trigger").addEventListener("click", async () => {
  console.log("p10-release-marker-log");
  try { await fetch("./api/data?access_token=p10_release_url_secret&page=2", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: "p10-release-request-body-sentinel" }) }).then((r) => r.text()); } catch {}
  document.getElementById("status").textContent = "status: triggered";
});
document.getElementById("submit").addEventListener("click", () => {
  document.getElementById("status").textContent = "status: clicked";
});
setTimeout(() => { document.getElementById("delayed").textContent = "delayed-token-p10-visible"; }, 1500);
setTimeout(() => { document.title = "P10 Release Delayed"; }, 2500);
</script>
</body></html>`;

const NEXT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>P10 Release Next</title></head>
<body><h1>P10 Release Next</h1><div id="status" role="status">status: next</div></body></html>`;

let ctx: LiveContext | null = null;

afterAll(async () => {
  if (ctx !== null) {
    const current = ctx;
    ctx = null;
    await closeLiveSession(current).catch(() => undefined);
  }
}, 120_000);

function structuredSnapshot(result: Awaited<ReturnType<typeof callTool>>): { snapshotId: string; tabId: string; nodes: Array<{ ref?: string; role: string; name?: string; value?: string }>; text: string } {
  if (result.isError === true) {
    throw new Error(`browser_snapshot failed: ${JSON.stringify(result.content).slice(0, 800)}`);
  }
  return result.structuredContent as { snapshotId: string; tabId: string; nodes: Array<{ ref?: string; role: string; name?: string; value?: string }>; text: string };
}

describe("P10 release matrix over MCP", () => {
  it(
    "exercises every registered public tool with cross-feature semantics",
    async () => {
      const { base, server } = await startFixture((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/" || url.pathname === "/index.html") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(FIXTURE_HTML);
          return;
        }
        if (url.pathname === "/next") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(NEXT_HTML);
          return;
        }
        if (url.pathname === "/api/data") {
          let received = 0;
          req.on("data", (chunk: Buffer) => {
            received += chunk.length;
          });
          req.on("end", () => {
            void received;
            res.writeHead(200, { "content-type": "application/json", "X-Test-Safe-Response": "safe" });
            res.end(JSON.stringify({ ok: true, echo: "p10-release-response-body-sentinel" }));
          });
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      });
      ctx = await startLiveSession("arc-mcp-p10-release-client");
      ctx.fixtureServer = server;
      const fixtureUrl = `${base}/`;
      const nextUrl = `${base}/next`;

      // Registered tool set matches the frozen P10 list (zero new tools).
      const { tools } = await ctx.client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...P10_FROZEN_PUBLIC_TOOLS]);

      // Status + tabs.
      const status0 = await callTool(ctx.client, "browser_status");
      expect(status0.isError).not.toBe(true);
      const opened = await openDisposableTab(ctx, fixtureUrl);
      const selected = await callTool(ctx.client, "browser_select_tab", { tabId: opened.id });
      expect(selected.isError).not.toBe(true);

      // Navigation (+history caveat): navigate to /next, then back/forward
      // accept either real history or BROWSER_HISTORY_UNAVAILABLE.
      const nav = await callTool(ctx.client, "browser_navigate", { url: nextUrl });
      expect(nav.isError).not.toBe(true);
      const back = await callTool(ctx.client, "browser_go_back");
      if (back.isError === true) {
        expect(toolErrorCode(back)).toBe("BROWSER_HISTORY_UNAVAILABLE");
      }
      const forward = await callTool(ctx.client, "browser_go_forward");
      if (forward.isError === true) {
        expect(toolErrorCode(forward)).toBe("BROWSER_HISTORY_UNAVAILABLE");
      }
      const reload = await callTool(ctx.client, "browser_reload");
      expect(reload.isError).not.toBe(true);
      // Return to the fixture for the interaction matrix.
      await callTool(ctx.client, "browser_navigate", { url: fixtureUrl });

      // Snapshot + interactions.
      let snapshot = structuredSnapshot(await callTool(ctx.client, "browser_snapshot"));
      expect(snapshot.tabId).toBe(opened.id);
      const heading = snapshot.nodes.find((n) => n.role === "heading" && n.ref !== undefined)?.ref;
      const textbox = snapshot.nodes.find((n) => n.name === "Name" && n.ref !== undefined)?.ref;
      if (heading === undefined || textbox === undefined) {
        throw new Error("fixture snapshot missing heading/textbox refs");
      }
      const text0 = await callTool(ctx.client, "browser_get_text", { ref: heading });
      expect(text0.isError).not.toBe(true);
      const fill = await callTool(ctx.client, "browser_fill", { ref: textbox, text: "hello" });
      expect(fill.isError).not.toBe(true);
      const staleProbe = await callTool(ctx.client, "browser_get_text", { ref: textbox });
      expect(toolErrorCode(staleProbe)).toBe("BROWSER_STALE_ELEMENT");
      snapshot = structuredSnapshot(await callTool(ctx.client, "browser_snapshot"));
      const textbox2 = snapshot.nodes.find((n) => n.name === "Name" && n.ref !== undefined)?.ref;
      if (textbox2 === undefined) {
        throw new Error("expected a fresh textbox ref");
      }
      const typed = await callTool(ctx.client, "browser_type", { ref: textbox2, text: " 世界🙂" });
      expect(typed.isError).not.toBe(true);
      const keyed = await callTool(ctx.client, "browser_press_key", { key: "Enter" });
      expect(keyed.isError).not.toBe(true);
      // Password: fill a sentinel; snapshot + getText never expose it.
      const sentinel = "p10-release-password-sentinel-9f3a";
      snapshot = structuredSnapshot(await callTool(ctx.client, "browser_snapshot"));
      const secretRef = snapshot.nodes.find((n) => n.name === "Secret" && n.ref !== undefined)?.ref;
      if (secretRef === undefined) {
        throw new Error("expected a secret ref");
      }
      const secretFill = await callTool(ctx.client, "browser_fill", { ref: secretRef, text: sentinel });
      expect(secretFill.isError).not.toBe(true);
      snapshot = structuredSnapshot(await callTool(ctx.client, "browser_snapshot"));
      expect(JSON.stringify(snapshot)).not.toContain(sentinel);
      const secretRef2 = snapshot.nodes.find((n) => n.name === "Secret" && n.ref !== undefined)?.ref;
      if (secretRef2 !== undefined) {
        const secretText = await callTool(ctx.client, "browser_get_text", { ref: secretRef2 });
        expect(secretText.isError).not.toBe(true);
        expect(JSON.stringify(secretText.structuredContent)).not.toContain(sentinel);
      }
      // Click invalidates the used ref.
      snapshot = structuredSnapshot(await callTool(ctx.client, "browser_snapshot"));
      const submitRef = snapshot.nodes.find((n) => n.role === "button" && n.name === "Submit" && n.ref !== undefined)?.ref;
      if (submitRef === undefined) {
        throw new Error("expected a submit ref");
      }
      expect((await callTool(ctx.client, "browser_click", { ref: submitRef })).isError).not.toBe(true);
      expect(toolErrorCode(await callTool(ctx.client, "browser_click", { ref: submitRef }))).toBe("BROWSER_STALE_ELEMENT");

      // Page tools.
      const evaluated = await callTool(ctx.client, "browser_evaluate", { expression: "40 + 2" });
      expect(evaluated.isError).not.toBe(true);
      expect(evaluated.structuredContent).toMatchObject({ kind: "json", value: 42 });
      const shot = await callTool(ctx.client, "browser_screenshot");
      expect(shot.isError).not.toBe(true);
      // Screenshot is read-only: fresh refs from a new snapshot still work and
      // the evaluate above already invalidated the old ones, so re-snapshot.
      snapshot = structuredSnapshot(await callTool(ctx.client, "browser_snapshot"));
      const shotRef = snapshot.nodes.find((n) => n.role === "heading" && n.ref !== undefined)?.ref;
      if (shotRef === undefined) {
        throw new Error("expected a heading ref after page tools");
      }
      // Wait for the delayed token rather than assuming timing.
      const waited = await callTool(ctx.client, "browser_wait_for", {
        condition: { type: "text", value: "delayed-token-p10-visible" },
        timeoutMs: 30_000,
      });
      expect(waited.isError).not.toBe(true);
      // Stable wait preserves refs on the same document.
      const afterWait = await callTool(ctx.client, "browser_get_text", { ref: shotRef });
      expect(afterWait.isError).not.toBe(true);

      // Observability: arm, trigger via evaluate (click-equivalent), poll,
      // clear, and prove no body/secret leakage.
      const armedConsole = await callTool(ctx.client, "browser_console", { action: "get" });
      expect(armedConsole.isError).not.toBe(true);
      const armedNetwork = await callTool(ctx.client, "browser_network", { action: "get" });
      expect(armedNetwork.isError).not.toBe(true);
      const trigger = await callTool(ctx.client, "browser_evaluate", { expression: "document.getElementById('trigger').click(); 'clicked'" });
      expect(trigger.isError).not.toBe(true);
      let sawConsole = false;
      let sawNetwork = false;
      {
        const deadline = Date.now() + 60_000;
        for (;;) {
          const current = await callTool(ctx.client, "browser_console", { action: "get" });
          const payload = current.structuredContent as { entries?: Array<{ text?: string }> } | undefined;
          if (Array.isArray(payload?.entries) && payload.entries.some((e) => (e.text ?? "").includes("p10-release-marker-log"))) {
            sawConsole = true;
            break;
          }
          if (Date.now() > deadline) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      }
      {
        const deadline = Date.now() + 60_000;
        for (;;) {
          const current = await callTool(ctx.client, "browser_network", { action: "get" });
          const payload = current.structuredContent as { entries?: Array<{ url?: string }> } | undefined;
          if (Array.isArray(payload?.entries) && payload.entries.some((e) => (e.url ?? "").includes("/api/data"))) {
            sawNetwork = true;
            const serialized = JSON.stringify(payload);
            expect(serialized).not.toContain("p10-release-request-body-sentinel");
            expect(serialized).not.toContain("p10-release-response-body-sentinel");
            expect(serialized).not.toContain("p10_release_url_secret");
            expect(serialized).not.toContain("postData");
            expect(serialized).not.toContain("requestId");
            break;
          }
          if (Date.now() > deadline) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      }
      expect(sawConsole).toBe(true);
      expect(sawNetwork).toBe(true);
      expect((await callTool(ctx.client, "browser_console", { action: "clear" })).isError).not.toBe(true);
      expect((await callTool(ctx.client, "browser_network", { action: "clear" })).isError).not.toBe(true);

      // Privileged negatives on a disposable new-tab page.
      const privilegedOpen = await callTool(ctx.client, "browser_open_tab", {});
      expect(privilegedOpen.isError).not.toBe(true);
      const privilegedTab = (privilegedOpen.structuredContent as { tab: { id: string } }).tab;
      ctx.ownedTabIds.add(privilegedTab.id);
      const seen = structuredTabs(await callTool(ctx.client, "browser_list_tabs")).tabs.find((t) => t.id === privilegedTab.id);
      expect(seen).toBeDefined();
      if (seen !== undefined && /^https?:/i.test(seen.url)) {
        throw new Error(`disposable privileged tab unexpectedly controllable: ${seen.url}`);
      }
      expect(toolErrorCode(await callTool(ctx.client, "browser_console", { action: "get" }))).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
      expect(toolErrorCode(await callTool(ctx.client, "browser_network", { action: "get" }))).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
      expect(toolErrorCode(await callTool(ctx.client, "browser_evaluate", { expression: "1" }))).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
      expect(toolErrorCode(await callTool(ctx.client, "browser_screenshot", {}))).toBe("BROWSER_TAB_NOT_CONTROLLABLE");
      await callTool(ctx.client, "browser_select_tab", { tabId: opened.id });
      const privilegedClose = await callTool(ctx.client, "browser_close_tab", { tabId: privilegedTab.id });
      expect(privilegedClose.isError).not.toBe(true);
      ctx.ownedTabIds.delete(privilegedTab.id);

      // Cleanup + survivor verification.
      const current = ctx;
      ctx = null;
      await closeLiveSession(current);
    },
    BOUND_MS,
  );
});
