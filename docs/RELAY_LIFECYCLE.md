# Relay lifecycle audit (P10, §3)

Authoritative account of the P03B bridge lifecycle and the deferred
"occasional native-host/relay cycling" observation.

## Chain

```
Arc extension (MV3 service worker)
  --chrome.runtime.connectNative("com.arc_mcp.bridge")--> native host process
  --Windows named pipe (framed RPC, nonce hello)--> Node McpPipeServer / RpcPeer
```

## What creates a native host process

- The extension owns the native port: `ExtensionBridge.ensureConnected()`
  calls `chrome.runtime.connectNative(hostName)`. Chrome spawns the
  registered launcher (`arc-mcp-native-host.cmd` -> `node
  dist/bridge/native-host/main.js`) with argv `[origin,
  --parent-window=N]`.
- Triggers: worker startup (`bridge.ensureConnected()` at import),
  disconnect/timeout reconnect (bounded backoff timer in `bridge.ts`),
  the 1-minute repeating alarm `arc-mcp-bridge-retry` (MV3 wake safety
  net), and any `ARC_MCP_GET_BRIDGE_STATUS` UI interaction.

## What normally causes it to exit

- Exit 0: stdin EOF after serving (Chrome tore down the port because the
  MCP pipe closed, the worker suspended, or connectNative was replaced),
  or clean relay end on pipe close.
- Exit 1: wrong caller origin (never touches the pipe).
- Exit 2: no active session file (no MCP process currently owns the
  pipe). This is the normal idle state when Arc runs without arc-mcp.
- Exit 3: stale session (owner PID gone); waits for a fresh MCP session.
- Exit 4: pipe connect failed. Exit 5: hello rejected/timed out.
  Exit 6: framing/protocol fatal (malformed or oversized frame).
- The `relayLoop` releases stdio/pipe handles (`stdin.pause()` + unref)
  so the process can actually exit instead of orphaning.

## Worker suspension / connectNative disconnect

- `ExtensionBridge.handleDisconnect(port)` clears only when the disconnect
  belongs to the CURRENT port (`if (this.port !== port) return`), fails
  pending extension-initiated requests, records `lastError`, increments
  `attempts`, and schedules exactly one reconnect via
  `scheduleReconnect()` (guarded by `retryTimer !== null` and `closed`).
- `ensureConnected()` is re-entrancy safe (`connecting` flag, returns
  early when a port exists).

## Named-pipe disconnect

- `McpPipeServer` clears `this.relay` only when the closing socket IS the
  authoritative relay; the peer's pending requests are rejected with
  `NOT_CONNECTED`; state converges `connected -> waiting`. `stop()`
  closes the peer, destroys the socket, closes the listener, and removes
  the session file.
- `ArcExtensionEngine.observeRelay()` flips `connected -> disconnected`
  with `BRIDGE_RELAY_LOST`; `status()` reports `connected` only when
  `state === "connected" && runtime.isRelayConnected()`.

## Alarms vs disconnect callbacks (no duplicate reconnects)

- Both paths funnel into `ensureConnected()`/`scheduleReconnect()`, which
  are idempotent: at most one pending `retryTimer` exists. The alarm fires
  at most once per minute and `ensureConnected()` no-ops when connected
  or connecting. A late `onDisconnect` for an OLD port is ignored by the
  port-identity check, so it cannot tear down or duplicate the new
  session. Proven by
  `tests/reliability/relayRecovery.test.ts` ("duplicate
  alarms/disconnects schedule exactly one retry").
- No second connection state machine was added in P10: the extension
  `ExtensionBridge` plus the single `McpPipeServer.relay` slot remain the
  only authorities. `handleRelayRequest` rejects a second authenticated
  hello (`bridge already has an authenticated relay`).

## Sessions, peers, and process overlap

- One `McpPipeServer` owns one pipe, one session file (256-bit nonce,
  atomic write, removed on `stop()`), and at most one authenticated
  `RpcPeer`. A second MCP process gets `PIPE_BUSY` (EADDRINUSE).
- Native-host processes never overlap on one connection: each host holds
  one pipe socket; when the pipe closes the host exits (code 0 path via
  `onPipeClose`), and Chrome-side reconnect spawns a fresh host only
  after the old port disconnected. Exited children are reaped by Chrome
  (the host is a child of the browser/launcher chain, not of Node), and
  Node never spawns or tracks host PIDs, so there is nothing to reap
  Node-side.
- `RpcPeer.close()` rejects every pending request and clears timers; the
  hello-timeout timer is unref'd; `failPending` clears extension-side
  timers. No unbounded retry queues or pending-promise maps exist.

## The deferred P03B cycling: verdict

The journal (`%LOCALAPPDATA%\arc-mcp\native-host\launches.log`) shows
steady low-rate host starts (typically ~7/minute, i.e. roughly one per
~8-9 s, consistent with the extension reconnect cadence plus alarm
firing while no MCP session exists), each exiting promptly with code 2
or 3. Live process enumeration during P10 showed zero accumulated
`node.exe native-host/main.js` instances outside active test relays.

This cycling is legitimate and bounded:

1. Without a running MCP process there is no session, so every
   extension-initiated `connectNative` spawns a host that validates the
   origin, finds no session, logs one line, and exits 2. Nothing
   accumulates: no pipe session, no peer, no timer beyond the single
   scheduled retry, no debugger state.
2. With a running MCP process, the first host authenticates and the relay
   stays up; `bridge:live-test` (ping-1/2/3 + restart-reconnect) proves a
   stable session with no cycling during healthy operation.
3. The ~10-19-line bursts visible in a few journal minutes correspond to
   overlapping worker-restart + alarm + UI-triggered connects racing a
   host that exits 2; each still exits promptly and the extension-side
   dedupe keeps exactly one retry timer.

No leak or race was demonstrated, so no production lifecycle change was
made in P10 (diagnosis first; fix only the smallest proven cause). The
deterministic mocked coverage in `tests/reliability/` locks the
no-accumulation invariant: single authoritative relay, duplicate-hello
rejection, disconnect cleanup, reconnect recovery, one-retry scheduling,
and status convergence.
