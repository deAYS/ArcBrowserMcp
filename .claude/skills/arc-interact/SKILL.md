---
name: arc-interact
description: Snapshot Arc pages and operate their controls via arc-mcp - click, fill, type, key press, element text, JavaScript evaluation. Use when clicking buttons/links, filling forms, typing, pressing keys, reading element content, or running page JS.
allowed-tools: mcp__arc-mcp__browser_snapshot mcp__arc-mcp__browser_get_text
---

# Arc interaction via arc-mcp

Mutating tier: only snapshot/get-text are pre-approved; clicks, fills, key presses, and evaluation follow normal permission prompts. Needs a selected tab (see `arc-navigate`); verify read-only state with `arc-observe`.

## Flow

1. `browser_snapshot {maxNodes?}` (max 1500) — get opaque element `ref`s. Refs are latest-snapshot-only.
2. Act once: `browser_click {ref}` | `browser_fill {ref, text}` (replace) | `browser_type {ref, text}` (append at caret) | `browser_press_key {key}` (Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space + Control/Shift/Alt/Meta) | `browser_evaluate {expression, timeoutMs?}` (by-value result only).
3. **Re-snapshot** before the next act — every action above invalidates prior refs.
4. Read back with `browser_get_text {ref}` (fresh read, keeps refs).

## Rules

- `BROWSER_STALE_ELEMENT` → take a fresh snapshot, never retry old refs.
- `browser_fill` needs an editable text control (`BROWSER_ELEMENT_NOT_EDITABLE`); unclickable state → `BROWSER_ELEMENT_NOT_INTERACTABLE`; outside the key allowlist → `BROWSER_INVALID_KEY`.
- `browser_evaluate` runs arbitrary page JS; a timeout stops waiting but cannot roll back JS the page already scheduled. Oversized results fail `BROWSER_EVALUATION_RESULT_TOO_LARGE` — narrow the expression.
- Passwords stay redacted; debugger owned by DevTools → `BROWSER_DEBUGGER_UNAVAILABLE`, leave it alone.
