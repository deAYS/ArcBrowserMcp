/**
 * Diagnostic page UI (runs in an extension page, classic script bundle).
 * Sends run/get requests to the service worker and renders the report.
 * No imports: this file is bundled standalone by esbuild.
 */

interface RenderableReport {
  verdict?: string;
  capabilities?: Record<string, Record<string, string> | string>;
  errors?: Record<string, string>;
  evidence?: Record<string, string | number | boolean>;
  notes?: string[];
  [key: string]: unknown;
}

let currentJson = "";

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing element #${id}`);
  }
  return node;
}

function render(report: RenderableReport): void {
  currentJson = JSON.stringify(report, null, 2);
  el("report").textContent = currentJson;
  const status = el("status");
  status.textContent = `Verdict: ${String(report.verdict ?? "unknown")}`;
  const tbody = document.querySelector("#matrix tbody");
  if (tbody === null) {
    return;
  }
  tbody.textContent = "";
  const capabilities = report.capabilities ?? {};
  for (const [group, checks] of Object.entries(capabilities)) {
    if (typeof checks === "object" && checks !== null) {
      for (const [name, value] of Object.entries(checks)) {
        const row = document.createElement("tr");
        const key = document.createElement("td");
        key.textContent = `${group}.${name}`;
        const val = document.createElement("td");
        val.textContent = String(value);
        val.className = value === "pass" ? "pass" : value === "fail" ? "fail" : "";
        row.appendChild(key);
        row.appendChild(val);
        tbody.appendChild(row);
      }
    }
  }
  const errors = report.errors ?? {};
  const errorKeys = Object.keys(errors);
  if (errorKeys.length > 0) {
    const row = document.createElement("tr");
    const key = document.createElement("td");
    key.textContent = "errors";
    const val = document.createElement("td");
    val.textContent = errorKeys.map((k) => `${k}: ${String(errors[k]).slice(0, 160)}`).join(" | ").slice(0, 600);
    row.appendChild(key);
    row.appendChild(val);
    tbody.appendChild(row);
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

async function loadPersisted(): Promise<void> {
  try {
    const response = await sendMessage({ type: "ARC_MCP_GET_REPORT" });
    if (response["ok"] === true && response["report"] !== null && typeof response["report"] === "object") {
      render(response["report"] as RenderableReport);
      el("status").textContent += " (persisted from previous run)";
    }
  } catch {
    el("status").textContent = "Idle. Could not reach the service worker.";
  }
}

async function run(): Promise<void> {
  el("status").textContent = "Running diagnostics in a dedicated test tab...";
  el("run").setAttribute("disabled", "");
  try {
    const response = await sendMessage({ type: "ARC_MCP_RUN_DIAGNOSTICS" });
    if (response["ok"] === true && typeof response["report"] === "object" && response["report"] !== null) {
      render(response["report"] as RenderableReport);
    } else {
      el("status").textContent = `Run failed: ${String(response["error"] ?? "unknown error")}`;
    }
  } catch (error: unknown) {
    el("status").textContent = `Run failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    el("run").removeAttribute("disabled");
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

async function refreshBridge(): Promise<void> {
  try {
    const response = await sendMessage({ type: "ARC_MCP_GET_BRIDGE_STATUS" });
    const status = response["status"];
    el("bridge-status").textContent =
      typeof status === "object" && status !== null ? JSON.stringify(status) : "Bridge status unavailable.";
  } catch {
    el("bridge-status").textContent = "Bridge status unavailable (service worker unreachable).";
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
void loadPersisted();
void refreshBridge();
