---
name: arc-observe
description: Read-only Arc page observability via arc-mcp - viewport screenshots, console entries, network metadata. Use when verifying page state, debugging errors, or inspecting requests without touching the page.
allowed-tools: mcp__arc-mcp__browser_screenshot mcp__arc-mcp__browser_console mcp__arc-mcp__browser_network
---

# Arc observability via arc-mcp

Read-only tier: never navigates, mutates, or invalidates snapshot refs. Needs a selected tab (see `arc-navigate`).

## Tools

- `browser_screenshot {}` — current viewport PNG only.
- `browser_console {action?:"get"|"clear", limit?}` (max 500) — bounded ring buffer.
- `browser_network {action?, limit?}` — request/response metadata only, no bodies (`hasPostData` boolean marker).

## Rules

- Safe to run between snapshot and interaction (see `arc-interact`) without losing refs.
- Sensitive headers, credentials, and console secret shapes are pre-redacted; secret matching is heuristic, not exhaustive.
- An MV3 worker restart can clear buffered entries; `clear` first for a clean capture window.
