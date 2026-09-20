# BrowserMcp

BrowserMcp exposes Arc Browser on Windows to MCP clients through a local stdio MCP server, an authenticated Windows named pipe, a Native Messaging host, and an Arc MV3 extension.

MCP clients speak stdio to BrowserMcp. BrowserMcp relays browser operations over a local authenticated named pipe to a Native Messaging host, which forwards them to the Arc MCP Bridge extension. The extension executes them with `chrome.tabs` and `chrome.debugger` against the running Arc Browser.

## Features

- Stable logical tab control (list, select, open, close)
- HTTP/HTTPS navigation plus back, forward, and reload
- Accessibility snapshots with opaque element refs
- Real click, fill, type, and key interaction
- Element text reads
- JavaScript evaluation with by-value results
- Viewport PNG screenshots
- Bounded semantic waits (load, URL, title, text)
- Console observability with bounded buffers
- Network metadata observability with bounded buffers
- Deterministic extension identity and deterministic extension builds
- Bounded reconnect and recovery behavior across bridge restarts

## Requirements

- Windows
- Arc Browser
- Node.js >= 22
- pnpm 10.18.1 or a compatible pnpm 10 setup
- Git

The primary backend is the Arc extension backend (`ArcExtensionEngine` driving the normal running Arc session through the extension bridge).

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

`ArcExtensionEngine` is the primary backend. It drives the normal running Arc session through the extension bridge (pipe server, session descriptor, and engine lifetime on the MCP side; extension, native host, and debugger automation on the browser side).

The dedicated Playwright/CDP Arc backend (`CdpBrowserEngine`) remains experimental because Arc's Windows/MSIX single-instance behavior prevents reliable dedicated profile startup while the normal Arc instance is running.

The extension requests exactly `debugger, tabs, storage, nativeMessaging, alarms` with empty `host_permissions`.

## Installation

```powershell
git clone https://github.com/deAYS/BrowserMcp.git
cd BrowserMcp
pnpm install
pnpm build
pnpm build:extension
```

Load the built output as an unpacked extension:

1. Open `arc://extensions` in Arc.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select `extension/dist/` from this repository checkout.

Expected deterministic extension ID:

```text
hgipaclbbilhkpdbobokbgjfeafcbkpc
```

The ID is derived from the committed public key in `extension/identity.json` with the Chromium algorithm. It must match after every rebuild. Then:

```powershell
pnpm bridge:install
pnpm bridge:check
pnpm bridge:ping
```

`pnpm bridge:install` generates machine-specific Native Messaging files under:

```text
%LOCALAPPDATA%\arc-mcp\native-host\
```

and registers:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.arc_mcp.bridge
```

Those generated files are local machine state. Do not commit them.

## Running

Build:

```powershell
pnpm build
```

Run:

```powershell
pnpm start
```

Development:

```powershell
pnpm dev
```

The MCP transport is stdio. `stdout` carries MCP protocol traffic only; diagnostics go to `stderr`. The generic MCP command concept is:

```text
node <repository>/dist/index.js
```

or `pnpm start` when launched from the repository root.

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
| `browser_click` | Dispatch a real left mouse click to a live snapshot element ref on the selected tab. Invalidates snapshot refs. |
| `browser_fill` | Replace an editable control's text with the supplied text (real keyboard/input mechanics, no script). Invalidates snapshot refs. |
| `browser_type` | Insert text at the caret without clearing the field (real input mechanics, no script). Invalidates snapshot refs. |
| `browser_press_key` | Dispatch a supported key/chord (Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space, optional Control/Shift/Alt/Meta) to the selected tab. Invalidates snapshot refs. |
| `browser_get_text` | Fresh semantic Accessibility read of a live snapshot element ref. Read-only; password/protected values stay redacted. |
| `browser_evaluate` | Evaluate JavaScript in the selected controllable page and return a by-value result. Arbitrary page JS may run; refs are invalidated after dispatch. |
| `browser_screenshot` | Capture the current viewport of the selected tab as PNG. Read-only; does not invalidate refs. |
| `browser_wait_for` | Bounded semantic wait (load/url/title/text) on the selected tab. Read-only; polling never allocates or invalidates refs. |
| `browser_console` | Read or clear bounded console entries for the selected tab. Read-only for the page; does not invalidate refs. |
| `browser_network` | Read or clear bounded request/response metadata for the selected tab (no bodies). Read-only for the page; does not invalidate refs. |

## Important Semantics

- Browser operations target the logically selected BrowserMcp tab.
- There is no active-tab fallback. Without a selected tab, tab-scoped tools fail with `BROWSER_NO_SELECTED_TAB`.
- Element refs are opaque project-owned strings. They are not DOM ids, node ids, or addresses.
- Refs are latest-snapshot-only. A newer capture replaces the usable ref generation for that tab.
- Navigation, click, fill, type, key presses, and dispatched evaluation invalidate prior refs.
- `browser_get_text`, `browser_screenshot`, bounded waits, and observability get/clear preserve refs.
- Privileged Arc/Chrome pages (for example `chrome://`, `arc://`, `devtools:`, `view-source:`, and other non-HTTP(S) pages) are rejected with `BROWSER_TAB_NOT_CONTROLLABLE`.
- Navigation only permits supported HTTP/HTTPS destinations. Other schemes, embedded credentials, and control characters are rejected with `BROWSER_URL_NOT_ALLOWED`.

## Security Model

- There is no TCP, HTTP, or WebSocket browser-control listener. MCP uses stdio.
- Extension-to-Node communication uses a local Windows named pipe plus Chrome Native Messaging. No browser control leaves the machine.
- A 256-bit per-session nonce authenticates bridge RPC. The nonce is generated per MCP process, written atomically to the session file, and verified with a constant-time comparison after connect.
- A wrong, absent, or stale nonce is rejected before any browser RPC runs.
- The nonce is never logged.
- The runtime session file is removed on clean stop.
- The exact extension origin (`chrome-extension://<extension-id>/`) is validated. Unknown origins and unknown host arguments fail closed.
- External debugger ownership is respected. A tab that already has a debugger attached is not stolen or detached; the operation fails with `BROWSER_DEBUGGER_UNAVAILABLE`.
- No generic CDP RPC is exposed. Only the fixed bridge method set is served.
- No request or response network bodies are collected. Network observability carries metadata only, with a boolean `hasPostData` marker instead of post data.
- Password and protected values fail closed. Password inputs are redacted in snapshots and are not readable through element text.
- Sensitive network headers and URL values are redacted: `Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization`, `X-Api-Key`, and `X-Auth-Token` values are replaced wholesale, and sensitive query values plus embedded URL credentials are sanitized.
- Arbitrary console-string secret detection is heuristic (Bearer/Basic and obvious key/value shapes) rather than a perfect arbitrary-secret guarantee. Structured headers and URLs are the strict boundary; console heuristics are defense in depth.

Pipe disclosure:

- The Windows named-pipe ACL currently uses:

```text
D:(A;;GA;;;WD)
```

which permits local connection attempts from Everyone. Do not treat the pipe as user-only.

- The 256-bit session nonce is the RPC authentication boundary. An unauthenticated local process cannot execute browser RPC: its hello is rejected and the socket is dropped.
- The broad ACL still leaves residual local connection-pressure and denial-of-service risk from other local processes. This is a known limitation.
- BrowserMcp is not intended to defend against malware already running with equivalent local-user privileges.

## Known Limitations

- Windows and Arc focus only.
- The dedicated Playwright/CDP backend is experimental for the reason described in Architecture.
- Arc native history may sometimes produce `BROWSER_HISTORY_UNAVAILABLE` for back/forward navigation.
- Element refs are latest-snapshot-only; refs from older snapshots fail with `BROWSER_STALE_ELEMENT`.
- An evaluation timeout bounds BrowserMcp waiting and retires the owned debugger attachment, but it cannot roll back arbitrary JavaScript already scheduled by the page.
- Screenshots are current-viewport PNG only. Full-page capture is rejected.
- Console and network observability are bounded (finite ring buffers, bounded retrieval limits, bounded serialized responses).
- No request or response bodies are available.
- An MV3 worker restart may clear in-memory observability buffers.
- Privileged and browser-internal pages are not controllable.
- The broad pipe ACL leaves the residual local connection-pressure risk described in Security Model (`PIPE_ACL_BROAD`).
- Arbitrary console secret detection is heuristic, not exhaustive.

## Development

`pnpm test` builds the extension first (via a `pretest` step), so a clean
checkout only needs:

```powershell
pnpm install
pnpm test
```

Individual steps remain available:

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

Bridge diagnostics:

```powershell
pnpm bridge:check
pnpm bridge:ping
pnpm bridge:live-test
```

Extension identity and determinism:

```powershell
pnpm extension:build-id
pnpm extension:id
pnpm extension:verify-deterministic
```

## Release Validation

These suites require a real Arc environment with the bridge extension loaded:

```powershell
pnpm test:reconnect
pnpm test:release
pnpm test:soak
```

`pnpm test:reconnect` exercises controlled bridge restart and recovery. `pnpm test:release` runs the full tool matrix against disposable fixture tabs. `pnpm test:soak` defaults to a long-running release/readiness test.

## Uninstall / Cleanup

```powershell
pnpm bridge:uninstall
```

This removes the generated native-host manifest and launcher and removes the `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.arc_mcp.bridge` registration. It removes only those generated host files; it does not delete sessions, profiles, or anything else.

The extension can then be removed from `arc://extensions`.

Runtime state lives under:

```text
%LOCALAPPDATA%\arc-mcp\
```

## License

MIT — see [LICENSE](LICENSE).
