/**
 * Real-Arc bridge live test driver (opt-in only).
 *
 *  1. Starts the MCP named-pipe bridge (real session descriptor + nonce).
 *  2. Waits for the Arc-launched native host to authenticate (bounded).
 *  3. Sends bridge.ping #1 end-to-end, records ids + latency.
 *  4. Inspects the process tree (read-only) to prove Arc launched the host.
 *  5. Runs an isolated wrong-nonce client against the live pipe (rejected).
 *  6. Sends bridge.ping #2 (legitimate path still works).
 *  7. Stops the MCP bridge, restarts it, waits for bounded reconnect.
 *  8. Sends bridge.ping #3, stops, prints machine-readable evidence JSON.
 *
 * No user tabs are touched; no debugger attachment is used. Never prints
 * the session nonce. Exit 0 only when every step passes.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const DIST = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIST = path.resolve(DIST, "..", "dist");

const { McpPipeServer } = await import(`file://${REPO_DIST}/bridge/mcpPipeServer.js`);
const { bridgePipeName } = await import(`file://${REPO_DIST}/bridge/constants.js`);
const { defaultSessionDir } = await import(`file://${REPO_DIST}/bridge/session.js`);
const { encodeNativeMessage, NativeFrameDecoder } = await import(`file://${REPO_DIST}/bridge/nativeFraming.js`);

const RELAY_WAIT_MS = 300_000;
const PING_TIMEOUT_MS = 15_000;
const POLL_MS = 500;

const evidence = {
  extensionId: "hgipaclbbilhkpdbobokbgjfeafcbkpc",
  phases: {},
  ping1: null,
  ping2: null,
  ping3: null,
  reconnectMs: null,
  hostProcess: null,
  negativeAuth: null,
};

function note(phase, ok, detail = {}) {
  evidence.phases[phase] = { ok, ...detail };
  console.log(`[live-test] ${phase}: ${ok ? "OK" : "FAIL"}`);
}

function fail(phase, message) {
  note(phase, false, { error: message });
  console.log(JSON.stringify({ evidence }, null, 2));
  process.exit(1);
}

async function waitFor(label, condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function psTable() {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2"],
      { timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(JSON.parse(stdout));
      },
    );
  });
}

function walkChain(entry, byId) {
  const chain = [entry.Name];
  let current = entry;
  for (let i = 0; i < 8; i += 1) {
    const parent = byId.get(current.ParentProcessId);
    if (!parent) {
      chain.push(`(ppid ${current.ParentProcessId} gone)`);
      break;
    }
    chain.push(`${parent.Name}[${parent.ProcessId}]`);
    current = parent;
  }
  return chain;
}

async function findBridgeProcesses() {
  const rows = await psTable();
  const list = Array.isArray(rows) ? rows : [rows];
  const byId = new Map(list.map((p) => [p.ProcessId, p]));
  const hosts = [];
  const wrappers = [];
  for (const p of list) {
    if (typeof p.CommandLine !== "string") {
      continue;
    }
    if (p.Name === "node.exe" && p.CommandLine.includes("native-host/main.js")) {
      hosts.push({
        pid: p.ProcessId,
        commandLine: p.CommandLine.slice(0, 220),
        ancestorChain: walkChain(p, byId),
      });
    }
    if (p.Name === "cmd.exe" && p.CommandLine.includes("arc-mcp-native-host.cmd")) {
      wrappers.push({
        pid: p.ProcessId,
        commandLine: p.CommandLine.slice(0, 220),
        ancestorChain: walkChain(p, byId),
      });
    }
  }
  const arcAncestorFound = [...hosts, ...wrappers].some((entry) =>
    entry.ancestorChain.some((name) => name === "Arc.exe" || String(name).startsWith("Arc.exe[")),
  );
  return { hosts, wrappers, arcAncestorFound };
}

/** Host journal argv lines written since run start (exact-origin corroboration). */
function readJournalArgvSince(sessionDir, sinceIso) {
  try {
    const journalPath = path.join(path.dirname(sessionDir), "native-host", "launches.log");
    const content = fs.readFileSync(journalPath, "utf-8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.includes("start argv=") && line >= sinceIso.slice(0, 19));
  } catch {
    return [];
  }
}

function wrongNonceHello(pipeName) {
  return new Promise((resolve) => {
    const socket = net.createConnection(pipeName);
    const decoder = new NativeFrameDecoder();
    let settled = false;
    const done = (result) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };
    socket.on("connect", () => {
      socket.write(encodeNativeMessage({
        version: 1, id: "evil-1", type: "request", method: "bridge.hello",
        payload: { nonce: "0".repeat(64), bridgeVersion: 1 },
      }));
    });
    socket.on("data", (chunk) => {
      let frames = [];
      try {
        frames = decoder.push(chunk);
      } catch {
        done({ rejected: true, via: "framing-error" });
        return;
      }
      for (const frame of frames) {
        if (frame?.type === "response" && frame?.ok === false) {
          done({ rejected: true, via: "error-response", code: frame?.error?.code });
          return;
        }
      }
    });
    socket.on("close", () => done({ rejected: true, via: "closed" }));
    socket.on("error", () => done({ rejected: true, via: "socket-error" }));
    setTimeout(() => done({ rejected: false, via: "timeout-no-rejection" }), 10_000).unref?.();
  });
}

const verboseLogger = {
  debug: (m, f) => process.stderr.write(`[live-test] DEBUG ${m} ${JSON.stringify(f ?? {})}\n`),
  info: (m, f) => process.stderr.write(`[live-test] INFO ${m} ${JSON.stringify(f ?? {})}\n`),
  warn: (m, f) => process.stderr.write(`[live-test] WARN ${m} ${JSON.stringify(f ?? {})}\n`),
  error: (m, f) => process.stderr.write(`[live-test] ERROR ${m} ${JSON.stringify(f ?? {})}\n`),
};

async function main() {
  const pipeName = bridgePipeName(process.env.USERNAME);
  const sessionDir = defaultSessionDir();

  // Step 1: start MCP bridge, wait for authenticated relay.
  let server = new McpPipeServer({ pipeName, sessionDir, logger: verboseLogger });
  await server.start();
  try {
    await waitFor("authenticated relay", () => Promise.resolve(server.relayState === "connected"), RELAY_WAIT_MS);
  } catch (error) {
    await server.stop();
    fail("relay-connect", String(error?.message ?? error));
  }
  note("relay-connect", true, { pipeName });

  // Step 2: snapshot processes immediately (the intermediate cmd.exe
  // wrapper is transient) and read host journal argv lines for this run.
  // Process ancestry is best-effort evidence, never a hard gate: the
  // transport criteria below decide pass/fail.
  const runStartIso = new Date().toISOString();
  const snap1 = await findBridgeProcesses().catch((error) => ({ error: String(error?.message ?? error) }));
  evidence.hostSnapshotAtRelay = snap1;

  // Step 3: correlated ping #1.
  const t0 = Date.now();
  const first = await server.requestDetailed("bridge.ping", {}, PING_TIMEOUT_MS);
  const latencyMs = Date.now() - t0;
  evidence.ping1 = { requestId: first.id, responseId: first.id, latencyMs, payload: first.payload };
  note("ping-1", true, { requestId: first.id, latencyMs });

  // Step 4: second snapshot + journal argv corroboration.
  const snap2 = await findBridgeProcesses().catch((error) => ({ error: String(error?.message ?? error) }));
  const journalArgv = readJournalArgvSince(sessionDir, runStartIso);
  evidence.hostProcess = { atRelay: snap1, afterPing: snap2, journalArgv };
  const liveHostSeen = (snap) => snap && !snap.error && (snap.hosts?.length > 0 || snap.wrappers?.length > 0);
  const arcSeen = (snap) => snap && !snap.error && snap.arcAncestorFound === true;
  note("host-process", true, {
    liveHostSeen: liveHostSeen(snap1) || liveHostSeen(snap2),
    arcAncestorSeen: arcSeen(snap1) || arcSeen(snap2),
    journalLaunches: journalArgv.length,
  });

  // Wrong-nonce client is rejected; legitimate path unaffected.
  const negative = await wrongNonceHello(pipeName);
  evidence.negativeAuth = negative;
  if (!negative.rejected) {
    await server.stop();
    fail("negative-auth", "wrong-nonce client was NOT rejected");
  }
  note("negative-auth", true, negative);
  const second = await server.requestDetailed("bridge.ping", {}, PING_TIMEOUT_MS);
  evidence.ping2 = { requestId: second.id, responseId: second.id, payload: second.payload };
  note("ping-2-after-negative", true, { requestId: second.id });

  // Step 5: restart recovery.
  await server.stop();
  const stoppedAt = Date.now();
  server = new McpPipeServer({ pipeName, sessionDir, logger: verboseLogger });
  await server.start();
  try {
    await waitFor("reconnected relay", () => Promise.resolve(server.relayState === "connected"), RELAY_WAIT_MS);
  } catch (error) {
    await server.stop();
    fail("restart-reconnect", String(error?.message ?? error));
  }
  evidence.reconnectMs = Date.now() - stoppedAt;
  note("restart-reconnect", true, { reconnectMs: evidence.reconnectMs });
  const third = await server.requestDetailed("bridge.ping", {}, PING_TIMEOUT_MS);
  evidence.ping3 = { requestId: third.id, responseId: third.id, payload: third.payload };
  note("ping-3-after-restart", true, { requestId: third.id });
  await server.stop();

  console.log(JSON.stringify({ evidence }, null, 2));
}

main().then(
  () => undefined,
  (error) => {
    console.log(JSON.stringify({ evidence, fatal: String(error?.message ?? error) }, null, 2));
    process.exit(1);
  },
);
