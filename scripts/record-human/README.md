# Record YOUR biometrics, tune the humanizer

Textbook constants fool basic checks; strong detectors (Cloudflare,
DataDome, HUMAN) model *your* distributions. This kit records your real
mouse + keyboard behavior (separately, so the channels stay unconfounded),
fits lognormal/Fitts/digraph parameters, and patches them into the
humanizer. Data never leaves this machine.

## 1. Record mouse (one run, no typing)

```powershell
powershell -ExecutionPolicy Bypass -File scripts/record-human/Record-Mouse.ps1
```

Use the browser normally for 2-3 minutes: click links, focus fields, open
menus. Do NOT type. ESC stops (it is not logged).

## 2. Record keyboard (one run, no mouse)

```powershell
powershell -ExecutionPolicy Bypass -File scripts/record-human/Record-Keyboard.ps1
```

Type ONLY the throwaway sample texts it prints - never passwords, secrets,
or personal messages. Everything you type IS captured. ESC stops.

Why separate runs: keystroke rhythm changes while you're also steering the
mouse (and vice versa). One channel at a time keeps the fits honest.

## 3. Analyze

```powershell
node scripts/record-human/analyze.mjs recordings/mouse-*.jsonl recordings/kb-*.jsonl
```

Prints fitted parameters (IKI/dwell lognormals, digraph speedups, WPM,
Fitts a/b, curvature, tremor, hover, hold, pauses) and writes
`recordings/human-profile.json`. Values with too few samples keep
literature defaults with a warning - record at least ~2-3 focused minutes
per channel (50+ keystrokes, 10+ mouse moves minimum; more is better).

## 4. Apply (optional)

```powershell
node scripts/record-human/analyze.mjs recordings/mouse-*.jsonl recordings/kb-*.jsonl --apply
```

Rewrites the `HUMAN PROFILE` block, the WPM default, and the digraph set
in `src/browser/interactionPolicy.ts`. Review with `git diff`, rebuild
(`tsc -p tsconfig.build.json`, `node extension/build.mjs`), reload the
extension, restart opencode. `--dry-run` previews without writing.

Then re-run the suites: `interactionPolicy`, `engineInteraction`,
`extensionInteraction`.

## Privacy

- `recordings/` is gitignored. Raw JSONL contains every key/click with
  timestamps - delete it after applying.
- Fitted constants are still YOUR biometrics: fine for local use, do NOT
  commit them to a public repo. Keep the tuning in your working tree only.

## Files

- `Record-Mouse.ps1` - 8 ms cursor poll + button edges, zero dependencies.
- `Record-Keyboard.ps1` - WH_KEYBOARD_LL hook, layout-aware chars
  (AZERTY/QWERTZ safe), zero dependencies.
- `analyze.mjs` - stdlib-only fits + profile emit/apply. Self-tested on
  synthetic data with known parameters (IKI, dwell, Fitts recovered).
