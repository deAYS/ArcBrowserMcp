/**
 * Fixture tab live status (runs in the disposable diagnostics test tab).
 * The suite focuses this tab while it runs, so the status line and tab
 * title below are the visible progress surface: polled from the service
 * worker, never driven by the runner itself.
 * No imports: this file is bundled standalone by esbuild.
 */

void ((): void => {

const IDLE_TEXT = "OK — disposable test tab ready";
const IDLE_TITLE = "Arc MCP Diagnostic Fixture";

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing element #${id}`);
  }
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function settledCounts(capabilities: unknown): string {
  if (!isRecord(capabilities)) {
    return "";
  }
  let pass = 0;
  let fail = 0;
  for (const checks of Object.values(capabilities)) {
    if (isRecord(checks)) {
      for (const value of Object.values(checks)) {
        if (value === "pass") {
          pass += 1;
        } else if (value === "fail") {
          fail += 1;
        }
      }
    }
  }
  return `${String(pass)} pass, ${String(fail)} fail`;
}

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
  const status = el("status");
  if (progress === null) {
    if (status.textContent !== IDLE_TEXT) {
      status.textContent = IDLE_TEXT;
      document.title = IDLE_TITLE;
    }
    return;
  }
  const current = progress["currentCheck"];
  const check = typeof current === "string" && current !== "" ? current : "starting…";
  let elapsed = "";
  const startedAt = progress["startedAt"];
  if (typeof startedAt === "string") {
    const ms = Date.parse(startedAt);
    if (!Number.isNaN(ms)) {
      elapsed = `${String(Math.max(0, Math.floor((Date.now() - ms) / 1000)))}s · `;
    }
  }
  const counts = settledCounts(progress["capabilities"]);
  const line = `Running… ${elapsed}${check}${counts === "" ? "" : ` (${counts})`}`;
  status.textContent = line;
  document.title = `(${check}) ${IDLE_TITLE}`;
}

window.setInterval(() => {
  void pollOnce();
}, 750);
void pollOnce();
})();
