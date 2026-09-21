# Release readiness (P10)

Factual product limitations for the extension-primary Windows MVP. No
marketing claims.

## Backend

- `ArcExtensionEngine` is the primary backend: MCP v2 (2026-07-28) ->
  `BrowserService` -> `BrowserEngine` -> `ArcExtensionEngine` ->
  authenticated Windows named pipe -> Native Messaging host
  (`com.arc_mcp.bridge`) -> Arc MV3 extension (`chrome.tabs` /
  `chrome.debugger` 1.3). Extension ID
  `hgipaclbbilhkpdbobokbgjfeafcbkpc`.
- The dedicated Playwright/CDP Arc backend (`CdpBrowserEngine`) remains
  experimental: Arc MSIX single-instance delegation prevents reliable
  dedicated-profile startup while normal Arc is running.
- Manifest permissions are exactly
  `debugger, tabs, storage, nativeMessaging, alarms` with
  `host_permissions: []`. No new public browser tools were added in P10
  (20 tools total, see `tests/release/toolsetSecurity.test.ts`).

## Tabs and selection

- Tools act on the logically selected project tab only (`TabId` opaque,
  epoch-qualified). There is no active-tab fallback.
- Stale/unknown `TabId`s fail closed (`BROWSER_TAB_NOT_FOUND`); refs from
  older snapshots fail closed (`BROWSER_STALE_ELEMENT`); no role/name
  retargeting.
- Pre-existing user tabs are never inspected or modified by tests; live
  suites record survivors and restore the originally active tab.

## Navigation

- `chrome.tabs.update` navigation does not always create traversable native
  history in Arc: `browser_go_back` / `browser_go_forward` return either a
  real history step or the approved typed `BROWSER_HISTORY_UNAVAILABLE`.
- Blocked schemes (`javascript:`, `data:`, `file:`, `chrome:`,
  `chrome-extension:`, `arc:`, plus `devtools:`/`view-source:` on create)
  are rejected before browser execution. Privileged pages
  (`chrome://`, `arc://`, `about:` except blank handling, etc.) are not
  controllable: `BROWSER_TAB_NOT_CONTROLLABLE`, rejected before debugger
  traffic.

## Snapshot and refs

- Accessibility semantic tree; latest-snapshot-only opaque element refs
  (`e-<32hex>-<snap>-<ctr>`). Any new capture, navigation, mutation, or
  evaluate dispatch invalidates prior refs. Read-only operations
  (get_text, screenshot, stable waits, observability get/clear) preserve
  refs.
- Password values are fail-closed redacted in snapshots and unreadable via
  get_text. Complete serialized snapshot capped at 256 KiB
  (`truncated: true` on trimming).

## Interactions

- Physical CDP input (`Input.dispatchMouseEvent/KeyEvent/insertText`);
  no `DOM.click`, no coordinate clicking, no `Runtime.callFunctionOn`.
- Fill replaces, type inserts; both bounded (32 KiB text limit;
  `BROWSER_INVALID_TEXT` / `BROWSER_INVALID_KEY` on validation).

## Page tools

- `browser_evaluate`: bounded expression (64 KiB), bounded timeout, by-value
  projection only. An await timeout retires the owned debugger attachment
  (never reused, never a foreign detach); page-side async work already
  scheduled may continue (no rollback claim).
- `browser_screenshot`: viewport PNG only, decoded cap 8 MiB, PNG signature
  verified.
- `browser_wait_for`: load/url/title/text with bounded timeouts and polling;
  never allocates refs.

## Observability

- Finite ring buffers: console default 200 / hard max 2000; network default
  500 / hard max 5000; retrieval max 500; network correlation hard max 2000
  (oldest pending evicted deterministically); complete serialized response
  max 512 KiB with newest-wins truncation.
- `Runtime.enable` (console) and `Network.enable` (network) are the only
  observability CDP capabilities. No `Runtime.getProperties`,
  `Network.getResponseBody`, `Network.getRequestPostData`, or storage
  access. No request/response bodies or postData are collected (boolean
  `hasPostData` only). Raw Chrome/CDP ids never exposed (opaque `n-*`
  network ids).
- Sensitive headers (`Authorization`, `Cookie`, `Set-Cookie`,
  `Proxy-Authorization`, `X-Api-Key`, `X-Auth-Token`) fully redacted;
  sensitive URL params and embedded credentials sanitized; console text gets
  bounded heuristic redaction (best-effort, not a perfect-secret guarantee).
- Buffers are in-memory per tab; an MV3 worker restart may reset them. No
  credential-bearing persistent observability storage exists.

## Bridge reliability

- Chrome Native Messaging legitimately starts/stops host processes: a host
  exiting with code 2 (no session) or 3 (stale session) when no MCP process
  owns the pipe is normal idle cycling, not a leak. The invariant is no
  accumulation of hosts, sessions, peers, timers, listeners, or debugger
  ownership (see `docs/RELAY_LIFECYCLE.md`).
- Extension reconnect is bounded exponential backoff (500 ms base, 10 s
  cap, single pending timer) plus a 1-minute wake alarm for MV3
  suspension. At most one authoritative authenticated relay per bridge
  instance; stale/duplicate hellos are rejected; late callbacks from old
  ports cannot corrupt the current session.
- Debugger lifecycle per tab: DETACHED/OWNED/RETIRING/UNCERTAIN. RETIRING
  serializes callers behind retirement; UNCERTAIN fails closed with
  `BROWSER_DEBUGGER_UNAVAILABLE`; foreign debuggers are never stolen or
  detached.
- Transport bounds: small/request frames 256 KiB, large responses 16 MiB,
  length checked before allocation; malformed/oversized frames fail closed.

## Pipe security

- The pipe DACL grants `D:(A;;GA;;;WD)` (Everyone, generic all) because the
  Arc-launched host runs under a restricted token that received EPERM with
  narrower ACLs. The 256-bit per-session nonce (constant-time compare,
  never logged, session file removed on shutdown) remains the RPC
  authentication boundary: wrong/absent/stale nonces are rejected before
  any browser RPC, and malformed auth cannot establish a peer.
- Residual risk is documented as `PIPE_ACL_BROAD` in the P10 handoff: any
  local process may connect and must still present the nonce; unauthenticated
  sockets are answered once and dropped, with a bounded hello timeout.
  Narrowing was not proven reliable in P10 and must not be guessed.
- No TCP/HTTP/WebSocket control listener exists (stdio MCP + named pipe +
  Native Messaging only). The 127.0.0.1 fixture servers in tests are
  disposable test infrastructure, not product transport.

## Build reproducibility

- Deterministic extension identity: `buildId` is SHA-256 over sorted
  extension inputs plus every extension-consumed shared source and
  bundler metadata (no timestamps). `pnpm build:extension` +
  `pnpm extension:verify-deterministic` must show matching repeated ids
  and bundle hashes. Any source affecting `background.js` must change the
  `buildId`; P10 changed no extension-consumed sources, so the P09
  `buildId` remains valid.
- Repository hygiene: no private signing key, `.env`, tokens, profiles,
  session files, logs, or `node_modules` are tracked. `extension/dist/`
  stays an untracked deterministic build artifact (as in prior phases).
