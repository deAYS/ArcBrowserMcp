# ArcBrowserMcp

Local MCP server for driving Arc Browser on Windows. Clients talk to it over stdio; it relays browser operations through an authenticated Windows named pipe to a Native Messaging host, which forwards them to the Arc MCP Bridge extension. The extension runs them with `chrome.tabs` and `chrome.debugger` against the running Arc instance.

- Logical tab control (list, select, open, close)
- HTTP/HTTPS navigation plus back, forward, reload
- Accessibility snapshots with opaque element refs
- Real click, fill, type, and key interaction
- Humanized composites: biometric typing (lognormal keystroke timing, real key events), neuromotor mouse paths, key sequences, click-type in one call
- Element text reads
- JavaScript evaluation with by-value results
- Viewport PNG screenshots
- Bounded semantic waits (load, URL, title, text)
- Console and network metadata observability with bounded buffers
- Deterministic extension identity and builds
- Reconnect and recovery across bridge restarts

## Requirements

- Windows
- Arc Browser
- Node.js >= 22
- pnpm 10.18.1 or a compatible pnpm 10 setup
- Git

Primary backend is the extension backend (`ArcExtensionEngine`), which drives the normal running Arc session through the extension bridge.

## Architecture

```text
MCP client
  ↓ stdio
BrowserMcp
  ↓ authenticated Windows named pipe
Native Messaging host
  ↓ Chrome Native Messaging
Arc MCP Bridge extension
  ↓
chrome.tabs / chrome.debugger
  ↓
Arc Browser
```

`ArcExtensionEngine` owns the MCP side (pipe server, session file, engine lifetime). The dedicated Playwright/CDP backend (`CdpBrowserEngine`) stays experimental: Arc's Windows/MSIX single-instance behavior prevents reliable dedicated-profile startup while the normal Arc instance is running.

Extension permissions are exactly `debugger, tabs, storage, nativeMessaging, alarms` with empty `host_permissions`.

## Setup

```powershell
git clone https://github.com/deAYS/ArcBrowserMcp.git
cd ArcBrowserMcp
pnpm install
pnpm build
pnpm build:extension
```

1. Load the built extension in Arc (`extension/dist/` from this checkout):
   1. Open `arc://extensions` in Arc.
   2. Enable Developer mode.
   3. Load unpacked, selecting the `extension/dist/` folder (for example `<absolute-path-to-repo>\extension\dist`).

Expected extension ID:

```text
hgipaclbbilhkpdbobokbgjfeafcbkpc
```

It is derived from the public key in `extension/identity.json` via the Chromium algorithm and must match after every rebuild. Then install and verify the Native Messaging bridge:

```powershell
pnpm bridge:install
pnpm bridge:check
pnpm bridge:ping
```

`bridge:install` writes machine-specific Native Messaging files to `%LOCALAPPDATA%\arc-mcp\native-host\` and registers `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.arc_mcp.bridge`. Those files are local state, do not commit them.

Finally, configure/start the MCP client to launch `node <absolute-path-to-repo>/dist/index.js` over stdio (see Running).

## Running

Start the MCP server over stdio:

```powershell
pnpm start    # runs node dist/index.js; MCP traffic goes over stdout, diagnostics go to stderr
```

Equivalent direct launch (use the checkout's absolute path):

```text
node <absolute-path-to-repo>/dist/index.js
```

Point any stdio-capable MCP client at this command, for example with command `node` and argument `<absolute-path-to-repo>/dist/index.js`. Verify with `pnpm build` first so `dist/` is current.

## Tools

| Tool | Description |
| ---- | ----------- |
| `browser_status` | Return browser connection state, selected tab, profile mode, and recoverable diagnostic state. |
| `browser_list_tabs` | List open tabs with stable tab IDs, titles, URLs, and selection state. |
| `browser_select_tab` | Select a tab by tab ID for subsequent operations. |
| `browser_open_tab` | Open a new tab, optionally at a URL. The new tab becomes selected. |
| `browser_close_tab` | Close a tab by tab ID. |
| `browser_navigate` | Navigate the selected tab to an allowed HTTP/HTTPS URL. |
| `browser_go_back` | Navigate the selected tab back in its history. |
| `browser_go_forward` | Navigate the selected tab forward in its history. |
| `browser_reload` | Reload the selected tab. |
| `browser_snapshot` | Capture a read-only semantic Accessibility snapshot of the selected tab with opaque element refs for later interaction. |
| `browser_click` | Dispatch a real left mouse click to a live snapshot element ref on the selected tab. Set `humanize` for a neuromotor mouse path (curved trajectory, hover dwell, press-hold). Invalidates snapshot refs. |
| `browser_fill` | Replace an editable control's text with the supplied text (real keyboard/input mechanics, no script). Invalidates snapshot refs. |
| `browser_type` | Insert text at the caret without clearing the field (real input mechanics, no script). Invalidates snapshot refs. |
| `browser_press_key` | Dispatch a supported key/chord (Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space, letters, digits, F1-F12, optional Control/Shift/Alt/Meta) to the selected tab. Invalidates snapshot refs. |
| `browser_type_human` | Type with biometric keystroke timing (lognormal flight/dwell, digraph speedups). `keys` mode (default) emits real per-character key events; `insert` uses paced CDP inserts; `rapid` emits real key events with zero pacing. Invalidates snapshot refs. |
| `browser_press_sequence` | Press an ordered key sequence with inter-key delay in one call. Invalidates snapshot refs. |
| `browser_click_type` | Real click then type (optionally humanized: neuromotor mouse path plus keystroke pacing) plus optional submit key in one call. Invalidates snapshot refs. |
| `browser_get_text` | Fresh semantic Accessibility read of a live snapshot element ref. Read-only; password/protected values stay redacted. |
| `browser_evaluate` | Evaluate JavaScript in the selected controllable page and return a by-value result. Arbitrary page JS may run; refs are invalidated after dispatch. |
| `browser_screenshot` | Capture the current viewport of the selected tab as PNG. Read-only; does not invalidate refs. |
| `browser_wait_for` | Bounded semantic wait (load/url/title/text) on the selected tab. Read-only; polling never allocates or invalidates refs. |
| `browser_console` | Read or clear bounded console entries for the selected tab. Read-only for the page; does not invalidate refs. |
| `browser_network` | Read or clear bounded request/response metadata for the selected tab (no bodies). Read-only for the page; does not invalidate refs. |

## Semantics

- Everything tab-scoped acts on the logically selected BrowserMcp tab. There is no active-tab fallback; without a selection these tools fail with `BROWSER_NO_SELECTED_TAB`.
- Element refs are opaque strings, not DOM or CDP ids, and are only valid for the latest snapshot of that tab.
- Navigation, click, fill, type, key press, humanized type, key sequence, click-type, and dispatched evaluation invalidate prior refs. `browser_get_text`, `browser_screenshot`, waits, and observability get/clear preserve them.
- Privileged pages (`chrome://`, `arc://`, `devtools:`, `view-source:`, other non-HTTP(S) pages) are rejected with `BROWSER_TAB_NOT_CONTROLLABLE`.
- Debugger sessions are idle-bounded: an attached tab with no CDP traffic for 60 s is detached (swept on next use plus a 1-minute alarm), so the automation surface drops shortly after you stop. Snapshot refs survive; the next operation reattaches transparently. Console/network events during a detached window are not collected.
- Navigation accepts HTTP/HTTPS destinations only. Other schemes, embedded credentials, and control characters fail with `BROWSER_URL_NOT_ALLOWED`.

## Security

- No TCP, HTTP, or WebSocket control listener. MCP uses stdio; browser traffic stays on the machine over the named pipe plus Native Messaging.
- Each MCP process generates a 256-bit session nonce, writes it atomically to the session file, and checks it with a constant-time comparison after connect. Wrong, absent, or stale nonces are rejected before any browser call. The nonce is never logged and the session file is removed on clean stop.
- The exact extension origin (`chrome-extension://<extension-id>/`) is validated; unknown origins and unrecognized host arguments fail closed.
- A tab with an external debugger attached is left alone; the operation fails with `BROWSER_DEBUGGER_UNAVAILABLE` instead of stealing it.
- No generic CDP RPC is exposed, only the fixed bridge method set.
- Network observability is metadata only. No request/response bodies or post data are collected (`hasPostData` is a boolean marker).
- Password and protected values fail closed: redacted in snapshots, unreadable via element text.
- Sensitive headers (`Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization`, `X-Api-Key`, `X-Auth-Token`) are replaced wholesale; sensitive URL query values and embedded credentials are sanitized. Console-text secret matching (Bearer/Basic, obvious key/value shapes) is heuristic, not a guarantee.

Pipe note: the ACL is currently

```text
D:(A;;GA;;;WD)
```

so any local process can attempt to connect; the pipe is not user-only. The 256-bit session nonce is the RPC authentication boundary — unauthenticated hellos are rejected and the socket dropped. The broad ACL still leaves residual local connection-pressure / denial-of-service risk. BrowserMcp does not defend against malware already running with the same user privileges.

## Limitations

- Windows and Arc only.
- Dedicated Playwright/CDP backend is experimental (see Architecture).
- Arc native history can return `BROWSER_HISTORY_UNAVAILABLE` for back/forward.
- Refs are latest-snapshot-only; older refs fail with `BROWSER_STALE_ELEMENT`.
- An evaluation timeout stops BrowserMcp waiting and retires the owned debugger attachment, but cannot roll back JS the page already scheduled.
- Screenshots are viewport PNG only; full-page capture is rejected.
- Console/network observability is bounded (ring buffers, retrieval caps, serialized response caps) with no bodies.
- An MV3 worker restart can clear in-memory observability buffers.
- Privileged and browser-internal pages are not controllable.
- Broad pipe ACL residual risk as described above (`PIPE_ACL_BROAD`).
- Console secret detection is heuristic, not exhaustive.

## Development

Clean checkout needs only:

```powershell
pnpm install
pnpm test
```

`pnpm test` builds the extension first via `pretest`. The individual steps:

```powershell
pnpm typecheck
pnpm build
pnpm build:extension
```

Focused suites:

```powershell
pnpm test:tabs
pnpm test:navigation
pnpm test:snapshot
pnpm test:interactions
pnpm test:page-tools
pnpm test:observability
pnpm test:extension-engine
pnpm test:reliability
```

Bridge and extension checks:

```powershell
pnpm bridge:check
pnpm bridge:ping
pnpm bridge:live-test
pnpm extension:build-id
pnpm extension:id
pnpm extension:verify-deterministic
```

`pnpm test:reconnect`, `pnpm test:release`, and `pnpm test:soak` need a real Arc environment with the bridge extension loaded. Soak is a long-running release/readiness test.

## Uninstall

```powershell
pnpm bridge:uninstall
```

Removes the generated manifest and launcher plus the `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.arc_mcp.bridge` registration (generated host files only). Then remove the extension from `arc://extensions`. Runtime state lives under `%LOCALAPPDATA%\arc-mcp\`.

## License

MIT — see [LICENSE](LICENSE).
