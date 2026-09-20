/**
 * Diagnostic page UI (runs in an extension page, classic script bundle).
 * Sends run/get requests to the service worker and renders the report.
 * While a run is in flight it shows elapsed time, the current phase, and
 * a live bridge status; results render as verdict/summary/environment
 * cards plus the matrix, evidence, notes, and full JSON.
 * No imports: this file is bundled standalone by esbuild.
 */

interface RenderableReport {
  verdict?: string;
  arcVersion?: string;
  chromiumVersion?: string;
  manifestVersion?: number;
  testUrl?: string;
  testTabId?: number | null;
  capabilities?: Record<string, Record<string, string> | string>;
  errors?: Record<string, string>;
  evidence?: Record<string, string | number | boolean>;
  notes?: string[];
  [key: string]: unknown;
}

interface ProgressView {
  running: boolean;
  currentCheck: string | null;
  capabilities: Record<string, Record<string, string> | string>;
  startedAt?: string;
}

interface BridgeStatusView {
  connected: string;
  attempts: string;
  lastError: string;
  buildId: string;
}

let currentJson = "";
let lastBuildId = "";

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing element #${id}`);
  }
  return node;
}

function tbodyOf(tableId: string): HTMLTableSectionElement {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (tbody === null) {
    throw new Error(`missing tbody in #${tableId}`);
  }
  return tbody as HTMLTableSectionElement;
}

function addRow(tbody: HTMLTableSectionElement, key: string, value: string, valueClass = ""): void {
  const row = document.createElement("tr");
  const keyCell = document.createElement("td");
  keyCell.textContent = key;
  keyCell.className = "key";
  const valueCell = document.createElement("td");
  valueCell.textContent = value;
  if (valueClass !== "") {
    valueCell.className = valueClass;
  }
  row.appendChild(keyCell);
  row.appendChild(valueCell);
  tbody.appendChild(row);
}

function statusClass(value: string): string {
  return value === "pass" ? "pass" : value === "fail" ? "fail" : "";
}

/** Checks in the suite; drives the hero counters and progress bar. */
const TOTAL_CHECKS = 16;

function updateHero(pass: number, fail: number, other: number): void {
  el("count-pass").textContent = String(pass);
  el("count-fail").textContent = String(fail);
  el("count-other").textContent = String(other);
  const settled = Math.min(pass + fail, TOTAL_CHECKS);
  const fill = document.getElementById("progress-fill");
  if (fill !== null) {
    fill.style.width = `${String(Math.round((settled / TOTAL_CHECKS) * 100))}%`;
  }
  el("summary").textContent = `${String(settled)} of ${String(TOTAL_CHECKS)} checks settled`;
}

function renderBridgeStatus(view: BridgeStatusView): void {
  const container = el("bridge-status");
  container.textContent = "";
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  addRow(tbody, "connected", view.connected, view.connected === "true" ? "pass" : "fail");
  addRow(tbody, "connect attempts", view.attempts);
  addRow(tbody, "last error", view.lastError);
  addRow(tbody, "extension build", view.buildId);
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderMatrix(capabilities: Record<string, Record<string, string> | string>): {
  pass: number;
  fail: number;
  other: number;
} {
  let pass = 0;
  let fail = 0;
  let other = 0;
  const matrixBody = tbodyOf("matrix");
  matrixBody.textContent = "";
  for (const [group, checks] of Object.entries(capabilities)) {
    if (typeof checks === "object" && checks !== null) {
      for (const [name, value] of Object.entries(checks)) {
        if (value === "pass") {
          pass += 1;
        } else if (value === "fail") {
          fail += 1;
        } else {
          other += 1;
        }
        addRow(matrixBody, `${group}.${name}`, String(value), statusClass(String(value)));
      }
    }
  }
  return { pass, fail, other };
}

function render(report: RenderableReport): void {
  currentJson = JSON.stringify(report, null, 2);
  el("report").textContent = currentJson;

  const verdict = String(report.verdict ?? "unknown");
  const verdictEl = el("verdict");
  verdictEl.textContent = `Verdict: ${verdict}`;
  verdictEl.className = verdict === "SUPPORTED" ? "verdict-supported" : verdict === "BLOCKED" ? "verdict-blocked" : "verdict-unknown";

  const { pass, fail, other } = renderMatrix(report.capabilities ?? {});
  updateHero(pass, fail, other);

  const envBody = tbodyOf("env");
  envBody.textContent = "";
  const env: Array<[string, string]> = [
    ["Arc version", String(report.arcVersion ?? "unknown")],
    ["Chromium version", String(report.chromiumVersion ?? "unknown")],
    ["Manifest version", String(report.manifestVersion ?? "unknown")],
    ["Test URL", String(report.testUrl ?? "unknown")],
    ["Test tab id", String(report.testTabId ?? "unknown")],
    ["Extension build", lastBuildId === "" ? "unknown (refresh bridge status)" : lastBuildId],
  ];
  for (const [key, value] of env) {
    addRow(envBody, key, value);
  }

  const evidenceBody = tbodyOf("evidence");
  evidenceBody.textContent = "";
  const evidenceEntries = Object.entries(report.evidence ?? {});
  if (evidenceEntries.length === 0) {
    addRow(evidenceBody, "evidence", "none recorded");
  }
  for (const [key, value] of evidenceEntries) {
    addRow(evidenceBody, key, String(value));
  }

  const notesEl = el("notes");
  notesEl.textContent = "";
  for (const note of report.notes ?? []) {
    const item = document.createElement("li");
    item.textContent = note;
    notesEl.appendChild(item);
  }

  const errorsEl = el("errors");
  errorsEl.textContent = "";
  for (const [key, message] of Object.entries(report.errors ?? {})) {
    const item = document.createElement("li");
    item.textContent = `${key}: ${message}`;
    errorsEl.appendChild(item);
  }
}

function sendMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response: unknown) => {
        if (chrome.runtime.lastError !== undefined) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve((response ?? {}) as Record<string, unknown>);
      });
    } catch (error: unknown) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function refreshBridge(): Promise<void> {
  try {
    const response = await sendMessage({ type: "ARC_MCP_GET_BRIDGE_STATUS" });
    const status = response["status"];
    if (!isRecord(status)) {
      el("bridge-status").textContent = "Bridge status unavailable.";
      return;
    }
    const pick = (key: string): string => {
      const value = status[key];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "—";
    };
    const buildId = pick("buildId");
    if (buildId !== "—") {
      lastBuildId = buildId;
    }
    renderBridgeStatus({
      connected: pick("connected"),
      attempts: pick("attempts"),
      lastError: pick("lastError"),
      buildId: lastBuildId === "" ? "unknown" : lastBuildId,
    });
  } catch {
    el("bridge-status").textContent = "Bridge status unavailable (service worker unreachable).";
  }
}

async function loadPersisted(): Promise<void> {
  try {
    const response = await sendMessage({ type: "ARC_MCP_GET_REPORT" });
    if (response["ok"] === true && isRecord(response["report"])) {
      render(response["report"] as RenderableReport);
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

// Phase hints shown while the worker runs the suite; the live currentCheck
// from the worker wins when present, these are elapsed-time fallback guidance.
const RUN_PHASES = [
  "Creating the disposable test tab…",
  "Attaching the debugger…",
  "Probing CDP domains…",
  "Exercising tabs and storage…",
  "Detaching and cleaning up the test tab…",
];

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
      render(response["report"] as RenderableReport);
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
