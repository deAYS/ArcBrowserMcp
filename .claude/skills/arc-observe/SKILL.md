---
name: arc-observe
description: Read-only Arc page observability via arc-mcp - viewport screenshots, console entries, network metadata. Use when verifying page state, debugging errors, or inspecting requests without touching the page.
allowed-tools: mcp__arc-mcp__browser_screenshot mcp__arc-mcp__browser_console mcp__arc-mcp__browser_network
---

# Arc observability via arc-mcp

Read-only tier: never navigates, mutates, or invalidates snapshot refs.
Needs a selected tab (see `arc-navigate`). Safe to interleave with
`arc-interact` flows between snapshot and action.

## Tool signatures

- `browser_screenshot {}` → `{mimeType: "image/png", dataBase64}`.
  Viewport only — no full-page option (`fullPage: true` is rejected).
- `browser_console {action?, limit?}` — `action: "get"` (default) returns
  `{tabId, monitoring, capacity, availableEntries, returnedEntries,
  droppedCount, truncated, entries: [{timestamp, level, text,
  source?}]}`; `action: "clear"` resets the buffer (`{cleared,
  removedEntries, monitoring}`). `limit` max 500 (default 100).
- `browser_network {action?, limit?}` — same envelope shape with
  `entries: [{id, startedAt, method, url, resourceType, requestHeaders,
  hasPostData, status, statusText, responseHeaders, mimeType, protocol,
  fromDiskCache, failed, errorText}]`. Bodies are never captured
  (`hasPostData` is a boolean marker only).

## Buffers and gaps (read this before trusting emptiness)

- Ring buffers live in the extension: console default 200 (max 2000),
  network default 500 (max 5000), tunable via server env
  (`ARC_MCP_CONSOLE_BUFFER_ENTRIES`, `ARC_MCP_NETWORK_BUFFER_ENTRIES`).
  Overflow drops oldest-first and counts `droppedCount`.
- An MV3 worker restart wipes buffers. An idle debugger detach (60 s
  without traffic — see `arc-navigate`) pauses event collection until the
  next operation reattaches. Either produces a silent gap: `clear` first
  for a clean capture window, then act, then `get`.
- `truncated: true` or nonzero `droppedCount` means you did not see
  everything — narrow the window instead of assuming absence.

## Rules

- Sensitive headers, credentials, and console secret shapes are pre-redacted;
  secret matching is heuristic, not exhaustive — treat output as
  semi-sensitive anyway.
- Console text is capped per entry; long payloads are cut, not paged.
- `monitoring: false` in a clear/get response means the tab is not currently
  attached — run any tab operation (or just snapshot) to re-arm, then retry.
- Errors are typed (`BROWSER_OBSERVABILITY_FAILED`,
  `BROWSER_NO_SELECTED_TAB`, `BROWSER_TAB_NOT_CONTROLLABLE`) — same recovery
  as `arc-navigate`/`arc-interact`: re-list, re-select, re-snapshot.
