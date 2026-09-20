/**
 * Diagnostic page UI (runs in an extension page, bundled by esbuild).
 * Sends run/get requests to the service worker and renders the report.
 * While a run is in flight it shows elapsed time, the current phase, and
 * a live bridge status; results render as verdict/summary/environment
 * cards plus the matrix, evidence, notes, and full JSON.
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

let currentJson = "";
let lastBuildId = "";

async function refreshBridge(): Promise<void> {
  const buildId = await refreshBridgeStatus();
  if (buildId !== "") {
    lastBuildId = buildId;
  }
}

async function loadPersisted(): Promise<void> {
  try {
    const response = await sendMessage({ type: "ARC_MCP_GET_REPORT" });
    if (response["ok"] === true && isRecord(response["report"])) {
      currentJson = render(response["report"] as RenderableReport, lastBuildId);
      el("status").textContent += " (persisted from previous run)";
    }
  } catch {
    el("status").textContent = "Idle. Could not reach the service worker.";
  }
}

// Live run state shared by the ticker and the always-on poller below, so a
// freshly opened page shows an in-flight run (started from any page) live.
let liveCheck: string | null = null;
let liveStartedAtMs: number | null = null;
let localRun = false;

function elapsedOf(startedAt: unknown): number | null {
  if (typeof startedAt === "string") {
    const ms = Date.parse(startedAt);
    if (!Number.isNaN(ms)) {
      return Math.max(0, Math.floor((Date.now() - ms) / 1000));
    }
  }
  if (liveStartedAtMs !== null) {
    return Math.max(0, Math.floor((Date.now() - liveStartedAtMs) / 1000));
  }
  return null;
}

/** Poll one live snapshot; returns true while a run is in flight. */
async function pollProgress(): Promise<boolean> {
  try {
    const response = await sendMessage({ type: "ARC_MCP_GET_DIAGNOSTICS_PROGRESS" });
    const progress = response["progress"];
    if (!isRecord(progress) || progress["running"] !== true) {
      if (!localRun) {
        el("run").removeAttribute("disabled");
      }
      return false;
    }
    if (isRecord(progress["capabilities"])) {
      const { pass, fail, other } = renderMatrix(
        progress["capabilities"] as ProgressView["capabilities"],
      );
      updateHero(pass, fail, other);
    }
    const current = progress["currentCheck"];
    liveCheck = typeof current === "string" ? current : liveCheck;
    if (typeof progress["startedAt"] === "string") {
      const ms = Date.parse(progress["startedAt"]);
      if (!Number.isNaN(ms)) {
        liveStartedAtMs = ms;
      }
    }
    el("run").setAttribute("disabled", "");
    // A foreign run (or a reload mid-run) has no local ticker, so the poller
    // itself owns the live status line; the local ticker overwrites this at
    // 500ms cadence while localRun is true — same text.
    if (!localRun) {
      const elapsed = elapsedOf(progress["startedAt"]);
      const phase = liveCheck
        ?? (elapsed !== null ? RUN_PHASES[Math.floor(elapsed / 4) % RUN_PHASES.length] : undefined)
        ?? RUN_PHASES[0]
        ?? "starting…";
      el("status").textContent = elapsed === null
        ? `Running… ${phase}`
        : `Running… ${elapsed}s elapsed — ${phase}`;
    }
    return true;
  } catch {
    return localRun;
  }
}

async function run(): Promise<void> {
  const running = await pollProgress();
  if (running) {
    return;
  }
  const runButton = el("run");
  runButton.setAttribute("disabled", "");
  localRun = true;
  liveCheck = null;
  liveStartedAtMs = Date.now();
  const ticker = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - (liveStartedAtMs ?? Date.now())) / 1000);
    const phase = liveCheck
      ?? RUN_PHASES[Math.floor(elapsed / 4) % RUN_PHASES.length]
      ?? RUN_PHASES[0]
      ?? "";
    el("status").textContent = `Running… ${elapsed}s elapsed — ${phase}`;
  }, 500);
  const bridgePoll = window.setInterval(() => {
    void refreshBridge();
  }, 2000);
  try {
    const response = await sendMessage({ type: "ARC_MCP_RUN_DIAGNOSTICS" });
    if (response["ok"] === true && isRecord(response["report"])) {
      currentJson = render(response["report"] as RenderableReport, lastBuildId);
      el("status").textContent = "Run complete.";
    } else {
      el("status").textContent = `Run failed: ${String(response["error"] ?? "unknown error")}`;
    }
  } catch (error: unknown) {
    el("status").textContent = `Run failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    window.clearInterval(ticker);
    window.clearInterval(bridgePoll);
    localRun = false;
    liveCheck = null;
    liveStartedAtMs = null;
    runButton.removeAttribute("disabled");
    void refreshBridge();
    void pollProgress();
  }
}

async function copyJson(): Promise<void> {
  try {
    await navigator.clipboard.writeText(currentJson);
    el("status").textContent += " (JSON copied)";
  } catch {
    el("status").textContent += " (copy failed: select the JSON manually)";
  }
}

el("run").addEventListener("click", () => {
  void run();
});
el("copy").addEventListener("click", () => {
  void copyJson();
});
el("bridge").addEventListener("click", () => {
  void refreshBridge();
});
void (async () => {
  await refreshBridge();
  // If a run is already in flight (started from another page, or this page
  // reloaded mid-run), show it live instead of the stale persisted report.
  const live = await pollProgress();
  if (!live) {
    await loadPersisted();
  }
  window.setInterval(() => {
    void pollProgress();
  }, 1000);
})();
