---
name: arc-navigate
description: Check Arc connection, manage tabs, navigate pages and wait for conditions via arc-mcp. Use when opening pages, switching tabs, going back/forward, reloading, or waiting for load, URL, title, or text.
allowed-tools: mcp__arc-mcp__browser_status mcp__arc-mcp__browser_list_tabs mcp__arc-mcp__browser_select_tab mcp__arc-mcp__browser_open_tab mcp__arc-mcp__browser_close_tab mcp__arc-mcp__browser_navigate mcp__arc-mcp__browser_go_back mcp__arc-mcp__browser_go_forward mcp__arc-mcp__browser_reload mcp__arc-mcp__browser_wait_for
---

# Arc navigation via arc-mcp

Windows + Arc only. Server runs from repo root (`pnpm build`, then `node dist/index.js`). Safe tier: no page mutation, no JS.

## Flow

1. `browser_status` — check `connected`, `selectedTabId`.
2. `browser_list_tabs` → `browser_select_tab {tabId}` (or `browser_open_tab {url?}`, `browser_close_tab {tabId}`). Every page tool acts on the selected tab only; without one they fail `BROWSER_NO_SELECTED_TAB`.
3. `browser_navigate {url}` (http/https only) → `browser_wait_for {condition, timeoutMs?}` with `{type:"load"}` | `{type:"url",match:"equals"|"contains",value}` | `{type:"title",match,value}` | `{type:"text",value}`. History: `browser_go_back {}`, `browser_go_forward {}`, `browser_reload {ignoreCache?}`.

## Rules

- Navigation invalidates snapshot refs — re-snapshot (see `arc-interact`) before touching elements.
- Privileged pages (`chrome://`, `arc://`, `devtools:`, `view-source:`, non-HTTP/S) fail `BROWSER_TAB_NOT_CONTROLLABLE`. Other schemes/credentials fail `BROWSER_URL_NOT_ALLOWED`.
- No history in that direction → `BROWSER_HISTORY_UNAVAILABLE`. Unsatisfied wait → `BROWSER_WAIT_TIMEOUT`; selection changed mid-wait → `BROWSER_WAIT_ABORTED`.
