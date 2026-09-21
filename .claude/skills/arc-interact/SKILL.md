---
name: arc-interact
description: Snapshot Arc pages and operate their controls via arc-mcp - click, fill, type, humanized typing, key sequences, click-type composites, element text, JavaScript evaluation. Use when clicking buttons/links, filling forms, humanized typing, pressing keys, reading element content, or running page JS.
allowed-tools: mcp__arc-mcp__browser_snapshot mcp__arc-mcp__browser_get_text mcp__arc-mcp__browser_click mcp__arc-mcp__browser_fill mcp__arc-mcp__browser_type mcp__arc-mcp__browser_type_human mcp__arc-mcp__browser_press_key mcp__arc-mcp__browser_press_sequence mcp__arc-mcp__browser_click_type mcp__arc-mcp__browser_evaluate
---

# Arc interaction via arc-mcp

Mutating tier: only snapshot/get-text are pre-approved; clicks, fills, key
presses, humanized composites, and evaluation follow normal permission
prompts. Needs a selected tab (see `arc-navigate`); verify read-only state
with `arc-observe`.

## Tool signatures

- `browser_snapshot {maxNodes?}` (max 1500, default caps internally) →
  `{snapshotId, tabId, url, title, nodes: [{ref, role, ...}], text,
  truncated, totalNodes, includedNodes}`. Refs are opaque, latest-snapshot-only.
- `browser_click {ref, humanize?}` — instant teleport click by default;
  `humanize: true` replays a neuromotor mouse path (curved trajectory, hover
  dwell, press-hold) from the last observed cursor position.
- `browser_fill {ref, text}` — replace control contents (max 32 KiB).
- `browser_type {ref, text}` — single insert at the caret (max 32 KiB).
- `browser_type_human {ref, text, wpm?, mode?}` — `wpm` 20–200 (default 80);
  `mode: "keys"` (default) emits real per-character key events with lognormal
  flight/dwell timing, digraph speedups, and thinking pauses;
  `mode: "insert"` uses paced CDP inserts (faster, no key-event trail).
  Password fields always use `insert`. Keys mode caps at 1500 chars.
- `browser_press_key {key}` — one key/chord: Enter, Tab, Escape, Backspace,
  Delete, arrows, Home, End, PageUp, PageDown, Space, letters, digits,
  F1–F12, `: ! ? " ( )` and other punctuation, all with optional
  Control/Shift/Alt/Meta (e.g. `Control+a`). Anything else →
  `BROWSER_INVALID_KEY` (validated before any bridge traffic).
- `browser_press_sequence {keys[], delayMs?}` — ordered keys, 1–50 items,
  fixed `delayMs` 0–2000 (default 60) between keys. The fixed cadence is
  the most robotic timing in the toolset — prefer `type_human` for text.
- `browser_click_type {ref, text, humanize?, wpm?, mode?, submitKey?}` —
  click then type plus one submit key (e.g. `"Enter"`); `humanize` (default
  true) drives BOTH the mouse path and keystroke pacing. Login/search flows.
- `browser_get_text {ref}` — fresh read of one element; keeps refs.
- `browser_evaluate {expression, timeoutMs?}` — page JS, by-value result
  only (64 KiB expression cap, bounded result size). Timeouts stop waiting
  but cannot roll back page effects.

## Flow

1. `browser_snapshot` → act exactly once → **re-snapshot** → act again.
   Every acting tool (click/fill/type/humans/keys/sequences/click-type/
   evaluate) invalidates prior refs. Only `browser_get_text` (and the
   `arc-observe` / `arc-navigate` reads) preserve them.
2. Rich-text editors (`contenteditable`, Slate/ProseMirror/Gmail-compose
   style): supported by fill/type/humans. Prefer `type_human` keys mode —
   it produces a real key-event trail; `fill` replaces content bluntly and
   suits plain inputs best.
3. Bot/rate-gated pages: `type_human` (keys) + `click` with `humanize: true`
   + read-like pauses between actions. Personal tuning kit:
   `scripts/record-human/` in the repo (record your mouse/typing, fit your
   parameters, `--apply` into the humanizer).

## Large snapshots and truncation

- Snapshots cap at 1500 nodes (`truncated: true`, `totalNodes` tells the
  real size). Late-tree elements (e.g. chat composers render last) get cut.
- When output truncates, the full JSON is saved to a tool-output file —
  grep it for the target (`"role":"textbox"`, `Message @…`) instead of
  re-snapshotting blindly.
- To shrink the tree legitimately: close side panels (profile/member lists),
  settle virtualized lists, or act on an earlier element first. Never guess
  refs — `BROWSER_STALE_ELEMENT` means re-snapshot, never retry old ones.

## Evaluate discipline

- `browser_evaluate` invalidates refs. Reads via evaluate are fine, but
  DOM writes (execCommand, value sets) bypass the page's editor model
  (Slate/etc.) and later trusted input can wipe the ghost text — verify
  with a read before acting on it, and prefer the interaction tools.
- `press_key` needs NO ref (acts on the focused element) — useful after
  focusing via click. It cannot type arbitrary text beyond the allowlist.

## Error catalog and recovery

- `BROWSER_STALE_ELEMENT` → fresh snapshot, never retry.
- `BROWSER_ELEMENT_NOT_EDITABLE` → target is not a text control (file
  inputs, checkboxes, number inputs, static text). Pick another ref.
- `BROWSER_ELEMENT_NOT_INTERACTABLE` → no visible geometry / overlapped.
- `BROWSER_INVALID_KEY` → outside the allowlist (see above).
- `BROWSER_INVALID_TEXT` → over a size cap or bad `wpm`/`mode`.
- `BROWSER_TAB_NOT_CONTROLLABLE` → privileged page; navigate away.
- `BROWSER_DEBUGGER_UNAVAILABLE` → DevTools owns the tab; leave it alone.
- `BROWSER_NO_SELECTED_TAB` → see `arc-navigate`.
- Error text never echoes fill/type payloads (length-only messages) — do not
  paste secrets into tool inputs casually anyway.

## Rules

- Text caps: 32 KiB UTF-8 for fill/type/click-type; 1500 chars for
  `type_human` keys mode. `wpm` 20–200, sequences max 50 keys.
- Passwords stay redacted in reads; debugger owned by DevTools → back off.
- After any repo rebuild (`tsc`, `extension/build.mjs`): reload the unpacked
  extension at `arc://extensions` and restart opencode, or tools fail with
  stale-bundle errors (`INVALID_ENVELOPE`, `ELEMENT_NOT_EDITABLE` on editors
  that should work).
