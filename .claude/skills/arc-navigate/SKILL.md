---
name: arc-navigate
description: Check Arc connection, manage tabs, navigate pages and wait for conditions via arc-mcp. Use when opening pages, switching tabs, going back/forward, reloading, or waiting for load, URL, title, or text.
allowed-tools: mcp__arc-mcp__browser_status mcp__arc-mcp__browser_list_tabs mcp__arc-mcp__browser_select_tab mcp__arc-mcp__browser_open_tab mcp__arc-mcp__browser_close_tab mcp__arc-mcp__browser_navigate mcp__arc-mcp__browser_go_back mcp__arc-mcp__browser_go_forward mcp__arc-mcp__browser_reload mcp__arc-mcp__browser_wait_for
---

# Arc navigation via arc-mcp

Windows + Arc/Chrome. The MCP server (`node <repo>/dist/index.js`, spawned by
opencode over stdio) drives the running browser through a bridge extension.
Safe tier: no page mutation, no JS. For clicking/typing see `arc-interact`;
for screenshots/console/network see `arc-observe`.

## Tool signatures

- `browser_status {}` → `{connected, state, backend, profileMode, selectedTabId, ...}`.
  `connected: true` + `backend: "extension"` is the healthy state.
- `browser_list_tabs {}` → `{tabs: [{id, title, url, active, pinned, windowId, controllable}], selectedTabId}`.
- `browser_select_tab {tabId}` — every page tool acts on the selected tab only.
- `browser_open_tab {url?}` — opens and selects; omit `url` for a blank tab.
- `browser_close_tab {tabId}`.
- `browser_navigate {url}` — http/https only.
- `browser_go_back {}` / `browser_go_forward {}` / `browser_reload {ignoreCache?}`.
- `browser_wait_for {condition, timeoutMs?}` — `condition` is one of:
  `{type:"load"}` | `{type:"url"|"title", match:"equals"|"contains", value}` |
  `{type:"text", value}`. Timeouts are bounded; the wait polls without
  invalidating snapshot refs.

## Flow

1. `browser_status` — confirm `connected`, note `selectedTabId`.
2. ALWAYS `browser_list_tabs` next, even if you plan to open a tab: it wakes
   the extension's tab registry. Skipping it can fail `browser_open_tab`
   with `UNKNOWN_METHOD: tab registry used before initialization` — just
   list tabs and retry.
3. `browser_select_tab {tabId}` for an existing tab, or `browser_open_tab`
   (with or without `url`).
4. `browser_navigate {url}` → `browser_wait_for {type:"load"}` (then a more
   specific url/title/text wait if the page renders late).
5. Hand off to `arc-interact` (`browser_snapshot` first — refs come only
   from snapshots).

## Error catalog and recovery

- `BROWSER_NO_SELECTED_TAB` → select or open a tab first.
- `BROWSER_TAB_NOT_FOUND` → the tab closed or ids rotated (e.g. after an
  extension reload); `list_tabs` again, never reuse old ids.
- `BROWSER_TAB_NOT_CONTROLLABLE` → privileged page (`chrome://`, `arc://`,
  `devtools:`, `view-source:`, `about:blank`, extension pages). Navigate away.
- `BROWSER_URL_NOT_ALLOWED` → non-http(s) scheme, embedded credentials, or
  control characters in the URL.
- `BROWSER_HISTORY_UNAVAILABLE` → no history in that direction.
- `BROWSER_WAIT_TIMEOUT` → condition never matched in budget; re-check state,
  widen the condition, retry. `BROWSER_WAIT_ABORTED` → selection changed or
  the tab vanished mid-wait; re-list, re-select.

## When the server itself is down

`MCP error -32000: Connection closed` means the server process exited before
answering `initialize` (it connects to the browser BEFORE serving MCP). In
the repo (`E:\project\ArcBrowserMcp` or wherever the checkout lives):

1. `node dist/bridge/cli.js check` — healthy must be `true`. If not,
   `node dist/bridge/cli.js install` (writes the native-host manifest +
   registry), then restart opencode.
2. `dist/` stale after source changes → `npx tsc -p tsconfig.build.json`
   (plus `node extension/build.mjs` if `extension/src` changed), then reload
   the unpacked extension at `arc://extensions`, then restart opencode.
3. Default extension-connect timeout (120 s) exceeds the opencode MCP timeout
   (60 s): a missing browser/extension looks like a hang, then -32000.

## Rules

- Navigation (navigate/back/forward/reload) invalidates snapshot refs —
  re-snapshot (see `arc-interact`) before touching elements. After
  select/open/close, always re-snapshot too: refs belong to one tab's latest
  snapshot and never transfer.
- Reads (`status`, `list_tabs`, `wait_for`, and all of `arc-observe`) never
  invalidate refs.
- Debugger sessions idle-detach after ~60 s without traffic (infobar drops);
  the next operation reattaches transparently. A `BROWSER_SNAPSHOT_FAILED`
  or similar on every tab usually means the loaded extension bundle is stale
  or its worker crashed — reload it at `arc://extensions`.
