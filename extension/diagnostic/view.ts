/**
 * Shared rendering for the diagnostics pages (diagnostic + fixture).
 * Both pages are bundled standalone by esbuild, so this module is compiled
 * into each bundle; the DOM contract is the element IDs both pages provide.
 */

export interface RenderableReport {
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

export interface ProgressView {
  running: boolean;
  currentCheck: string | null;
  capabilities: Record<string, Record<string, string> | string>;
  startedAt?: string;
}

export interface BridgeStatusView {
  connected: string;
  attempts: string;
  lastError: string;
  buildId: string;
}

export function el(id: string): HTMLElement {
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
export const TOTAL_CHECKS = 16;

export function updateHero(pass: number, fail: number, other: number): void {
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

export function renderBridgeStatus(view: BridgeStatusView): void {
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

export function renderMatrix(capabilities: Record<string, Record<string, string> | string>): {
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

/** Render a full report into every section; returns the JSON for copy. */
export function render(report: RenderableReport, lastBuildId: string): string {
  const json = JSON.stringify(report, null, 2);
  el("report").textContent = json;

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
  return json;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function sendMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
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

/** Refresh the bridge card; returns the build id ("" when unknown). */
export async function refreshBridgeStatus(): Promise<string> {
  try {
    const response = await sendMessage({ type: "ARC_MCP_GET_BRIDGE_STATUS" });
    const status = response["status"];
    if (!isRecord(status)) {
      el("bridge-status").textContent = "Bridge status unavailable.";
      return "";
    }
    const pick = (key: string): string => {
      const value = status[key];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "—";
    };
    const buildId = pick("buildId");
    renderBridgeStatus({
      connected: pick("connected"),
      attempts: pick("attempts"),
      lastError: pick("lastError"),
      buildId: buildId === "—" ? "unknown" : buildId,
    });
    return buildId === "—" ? "" : buildId;
  } catch {
    el("bridge-status").textContent = "Bridge status unavailable (service worker unreachable).";
    return "";
  }
}

// Phase hints shown while the worker runs the suite; the live currentCheck
// from the worker wins when present, these are elapsed-time fallback guidance.
export const RUN_PHASES = [
  "Creating the disposable test tab…",
  "Attaching the debugger…",
  "Probing CDP domains…",
  "Exercising tabs and storage…",
  "Detaching and cleaning up the test tab…",
];
