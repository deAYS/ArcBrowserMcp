/**
 * Fixture tab mirror of the diagnostics page (bundled by esbuild).
 * The suite focuses this disposable test tab while it runs, so this page
 * renders the same live status, verdict, environment, bridge, matrix,
 * notes, evidence, and JSON as diagnostic.html — view-only.
 * It never starts a run itself; the tab is removed when the run ends.
 */

import {
  RUN_PHASES,
  el,
  isRecord,
  refreshBridgeStatus,
  render,
  renderMatrix,
  sendMessage,
  updateHero,
  type ProgressView,
  type RenderableReport,
} from "./view.js";

const IDLE_TITLE = "Arc MCP Diagnostic Fixture";

let lastBuildId = "";
let lastJson = "";

function elapsedOf(startedAt: unknown): number | null {
  if (typeof startedAt === "string") {
    const ms = Date.parse(startedAt);
    if (!Number.isNaN(ms)) {
      return Math.max(0, Math.floor((Date.now() - ms) / 1000));
    }
  }
  return null;
}

async function showPersisted(): Promise<void> {
  let response: Record<string, unknown>;
  try {
    response = await sendMessage({ type: "ARC_MCP_GET_REPORT" });
  } catch {
    el("status").textContent = "Idle. Could not reach the service worker.";
    return;
  }
  if (response["ok"] !== true || !isRecord(response["report"])) {
    el("status").textContent = "Idle — waiting for a diagnostics run. Start one from the diagnostics page.";
    document.title = IDLE_TITLE;
    return;
  }
  const json = JSON.stringify(response["report"]);
  if (json === lastJson) {
    return;
  }
  lastJson = json;
  render(response["report"] as RenderableReport, lastBuildId);
  el("status").textContent = "Run complete.";
  document.title = IDLE_TITLE;
}

/** Poll one live snapshot; falls back to the persisted report when idle. */
async function pollOnce(): Promise<void> {
  let progress: Record<string, unknown> | null = null;
  try {
    const response = await sendMessage({ type: "ARC_MCP_GET_DIAGNOSTICS_PROGRESS" });
    if (isRecord(response["progress"]) && response["progress"]["running"] === true) {
      progress = response["progress"];
    }
  } catch {
    progress = null;
  }
  if (progress === null) {
    await showPersisted();
    return;
  }
  if (isRecord(progress["capabilities"])) {
    const { pass, fail, other } = renderMatrix(
      progress["capabilities"] as ProgressView["capabilities"],
    );
    updateHero(pass, fail, other);
  }
  const current = progress["currentCheck"];
  const check = typeof current === "string" && current !== "" ? current : "starting…";
  const elapsed = elapsedOf(progress["startedAt"]);
  const phase = current === null || current === ""
    ? RUN_PHASES[Math.floor((elapsed ?? 0) / 4) % RUN_PHASES.length] ?? "starting…"
    : check;
  el("status").textContent = elapsed === null
    ? `Running… ${phase}`
    : `Running… ${elapsed}s elapsed — ${phase}`;
  document.title = `(${check}) ${IDLE_TITLE}`;
}

async function refreshBridge(): Promise<void> {
  const buildId = await refreshBridgeStatus();
  if (buildId !== "" && buildId !== lastBuildId) {
    lastBuildId = buildId;
    if (lastJson !== "") {
      render(JSON.parse(lastJson) as RenderableReport, lastBuildId);
    }
  }
}

el("open-diagnostics").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("diagnostic/diagnostic.html") });
});

void (async () => {
  await refreshBridge();
  await pollOnce();
  window.setInterval(() => {
    void pollOnce();
  }, 1000);
  window.setInterval(() => {
    void refreshBridge();
  }, 5000);
})();
