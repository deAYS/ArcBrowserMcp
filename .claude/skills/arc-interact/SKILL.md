---
name: arc-interact
description: Snapshot Arc pages and operate their controls via arc-mcp - click, fill, type, humanized typing, key sequences, click-type composites, element text, JavaScript evaluation. Use when clicking buttons/links, filling forms, humanized typing, pressing keys, reading element content, or running page JS.
allowed-tools: mcp__arc-mcp__browser_snapshot mcp__arc-mcp__browser_get_text
---

# Arc interaction via arc-mcp

Mutating tier: only snapshot/get-text are pre-approved; clicks, fills, key presses, humanized composites, and evaluation follow normal permission prompts. Needs a selected tab (see `arc-navigate`); verify read-only state with `arc-observe`.

## Flow

1. `browser_snapshot {maxNodes?}` (max 1500) — get opaque element `ref`s. Refs are latest-snapshot-only.
2. Act once — instant: `browser_click {ref}` (add `humanize: true` for a neuromotor mouse path: curved trajectory, hover dwell, press-hold) | `browser_fill {ref, text}` (replace) | `browser_type {ref, text}` (append at caret) | `browser_press_key {key}` (Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space, letters, digits, F1-F12 + Control/Shift/Alt/Meta) | `browser_evaluate {expression, timeoutMs?}` (by-value result only).
3. Prefer humanized composites when the page has bot/rate checks or the flow needs several inputs in one call: `browser_type_human {ref, text, wpm?, mode?}` (`keys` default: real per-character key events with lognormal flight/dwell timing; `insert`: paced CDP inserts, faster but no key-event trail; passwords always insert; keys mode caps at 1500 chars) | `browser_press_sequence {keys[], delayMs?}` (e.g. `["Control+a","Backspace","Enter"]`) | `browser_click_type {ref, text, humanize?, wpm?, mode?, submitKey?}` (login/search in one call; humanize also drives the mouse path).
4. **Re-snapshot** before the next act — every action above invalidates prior refs.
5. Read back with `browser_get_text {ref}` (fresh read, keeps refs).

## Rules

- `BROWSER_STALE_ELEMENT` → take a fresh snapshot, never retry old refs.
- `browser_fill`/`browser_type_human`/`browser_click_type` need an editable text control (`BROWSER_ELEMENT_NOT_EDITABLE`); unclickable state → `BROWSER_ELEMENT_NOT_INTERACTABLE`; outside the key allowlist → `BROWSER_INVALID_KEY`.
- Sequences are bounded: max 50 keys, `delayMs` 0-2000, `wpm` 20-200, text 32 KiB. Oversized/empty sequences fail closed before any bridge traffic.
- `browser_evaluate` runs arbitrary page JS; a timeout stops waiting but cannot roll back JS the page already scheduled. Oversized results fail `BROWSER_EVALUATION_RESULT_TOO_LARGE` — narrow the expression.
- Passwords stay redacted; debugger owned by DevTools → `BROWSER_DEBUGGER_UNAVAILABLE`, leave it alone.
