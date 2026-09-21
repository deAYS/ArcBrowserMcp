#!/usr/bin/env node
/**
 * Human-profile analyzer: turns your recordings into fitted generator
 * parameters. Usage:
 *
 *   node scripts/record-human/analyze.mjs <recording.jsonl> [...] [--apply] [--dry-run]
 *
 * Without flags it prints a summary and writes recordings/human-profile.json.
 * --apply rewrites the HUMAN PROFILE block (plus WPM default + digraph set)
 * in src/browser/interactionPolicy.ts; --dry-run previews the new block.
 * Review with git diff afterwards. Your recordings never leave this machine
 * (recordings/ is gitignored); think twice before committing fitted values
 * upstream - they are YOUR biometrics.
 *
 * Statistics: lognormal fits (mu/sd over ln x), percentiles, least-squares
 * Fitts regression. Minimum sample gates keep tiny sessions from producing
 * silly values (defaults are kept with a warning instead).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY_PATH = path.join(REPO_ROOT, "src", "browser", "interactionPolicy.ts");
const RECORD_DIR = path.join(REPO_ROOT, "recordings");

const MIN_IKI = 50;
const MIN_DWELL = 50;
const MIN_SEGMENTS = 10;
const MIN_HOLD = 20;
const MIN_PAUSE = 15;
const MIN_CHARS_WPM = 200;
const MIN_ACTIVE_MIN = 1;

const MODIFIER_VK = new Set([16, 17, 18, 91, 92, 93, 20]);

function percentile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function lognormalFit(samples) {
  const logs = samples.map((v) => Math.log(v)).sort((a, b) => a - b);
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const variance = logs.reduce((a, b) => a + (b - mean) ** 2, 0) / logs.length;
  return { mu: mean, sigma: Math.sqrt(variance), median: Math.exp(mean) };
}

function linReg(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i += 1) {
    ssTot += (ys[i] - my) ** 2;
    ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
  }
  return { intercept, slope, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

function medianOf(values) {
  if (values.length === 0) return NaN;
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}

function resolveChar(ev) {
  if (typeof ev.ch === "string" && Array.from(ev.ch).length === 1) return ev.ch;
  if (ev.vk === 13) return "\n";
  if (ev.vk === 9) return "\t";
  if (ev.vk === 32) return " ";
  if (ev.vk >= 65 && ev.vk <= 90) return String.fromCharCode(ev.vk + 32);
  if (ev.vk >= 48 && ev.vk <= 57) return String.fromCharCode(ev.vk);
  return null;
}

function parseFiles(files) {
  const kb = [];
  const mouse = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const ev = JSON.parse(trimmed);
      if (ev.kind === "meta") continue;
      if (typeof ev.vk === "number") {
        const t = ev.unit === "micros" ? ev.t / 1000 : ev.t;
        kb.push({ t, vk: ev.vk, down: ev.type === "down", ch: ev.ch ?? "" });
      } else if (typeof ev.x === "number") {
        mouse.push({ t: ev.t, type: ev.type, button: ev.button ?? null, x: ev.x, y: ev.y });
      }
    }
  }
  kb.sort((a, b) => a.t - b.t);
  mouse.sort((a, b) => a.t - b.t);
  return { kb, mouse };
}

function isLetterChar(ch) {
  return typeof ch === "string" && /^[a-zA-Z]$/.test(ch);
}

function analyzeKeyboard(events) {
  // Drop the ESC stop key and de-duplicate auto-repeat.
  const stream = events.filter((e) => e.vk !== 27);
  const held = new Set();
  const downs = [];
  const dwells = [];
  const pendingDown = new Map();
  const active = new Set();
  let rolloverPresses = 0;
  let countablePresses = 0;

  for (const ev of stream) {
    if (MODIFIER_VK.has(ev.vk)) continue;
    if (ev.down) {
      if (held.has(ev.vk)) continue; // auto-repeat
      held.add(ev.vk);
      downs.push(ev);
      if (!pendingDown.has(ev.vk)) pendingDown.set(ev.vk, []);
      pendingDown.get(ev.vk).push(ev.t);
      if (active.size > 0) rolloverPresses += 1;
      countablePresses += 1;
      active.add(ev.vk);
    } else {
      held.delete(ev.vk);
      active.delete(ev.vk);
      const queue = pendingDown.get(ev.vk);
      if (queue !== undefined && queue.length > 0) {
        const start = queue.shift();
        const dwell = ev.t - start;
        if (dwell >= 10 && dwell <= 1000) dwells.push(dwell);
      }
    }
  }

  const chars = downs.map((e) => ({ t: e.t, ch: resolveChar(e) }));
  const ikis = [];
  const digraphs = new Map();
  const wordPauses = [];
  const sentencePauses = [];
  const newlinePauses = [];
  const longPauses = [];
  for (let i = 1; i < chars.length; i += 1) {
    const prev = chars[i - 1];
    const cur = chars[i];
    const dt = cur.t - prev.t;
    if (dt < 30 || dt > 3000) continue;
    ikis.push(dt);
    if (isLetterChar(prev.ch) && isLetterChar(cur.ch)) {
      const pair = `${prev.ch.toLowerCase()}${cur.ch.toLowerCase()}`;
      if (!digraphs.has(pair)) digraphs.set(pair, []);
      digraphs.get(pair).push(dt);
    }
    if (prev.ch === " ") wordPauses.push(dt);
    if (prev.ch === "." || prev.ch === "!" || prev.ch === "?") sentencePauses.push(dt);
    if (prev.ch === "\n") newlinePauses.push(dt);
    if (dt > 600) longPauses.push(dt);
  }

  // Active typing time (gaps over 3 s are thinking, not typing) for WPM.
  let activeMs = 0;
  let printable = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i].ch;
    if (ch !== null && ch !== "\n" && ch !== "\t") printable += 1;
    if (i > 0) {
      const gap = chars[i].t - chars[i - 1].t;
      if (gap < 3000) activeMs += gap;
    }
  }
  const activeMin = activeMs / 60000;
  const wpm = activeMin >= MIN_ACTIVE_MIN && printable >= MIN_CHARS_WPM ? printable / 5 / activeMin : NaN;

  const digraphList = [...digraphs.entries()]
    .filter(([, v]) => v.length >= 3)
    .map(([pair, v]) => ({ pair, n: v.length, median: medianOf(v) }))
    .sort((a, b) => b.n - a.n);

  return {
    nPress: downs.length,
    nIki: ikis.length,
    iki: ikis.length >= MIN_IKI ? lognormalFit(ikis) : null,
    ikiP1: ikis.length ? percentile([...ikis].sort((a, b) => a - b), 0.01) : NaN,
    ikiP99: ikis.length ? percentile([...ikis].sort((a, b) => a - b), 0.99) : NaN,
    dwell: dwells.length >= MIN_DWELL ? lognormalFit(dwells) : null,
    nDwell: dwells.length,
    digraphs: digraphList,
    rolloverRate: countablePresses > 0 ? rolloverPresses / countablePresses : 0,
    wordPause: wordPauses.length >= MIN_PAUSE ? lognormalFit(wordPauses) : null,
    sentencePause: sentencePauses.length >= MIN_PAUSE ? lognormalFit(sentencePauses) : null,
    newlinePause: newlinePauses.length >= MIN_PAUSE ? lognormalFit(newlinePauses) : null,
    longPauseMedian: longPauses.length >= 5 ? medianOf(longPauses) : NaN,
    thinkingProb: ikis.length >= MIN_IKI ? longPauses.length / ikis.length : NaN,
    wpm,
    printable,
    activeMin,
  };
}

function analyzeMouse(events) {
  const moves = events.filter((e) => e.type === "move");
  const clicks = events.filter((e) => e.type === "down" && e.button === "left");
  const ups = events.filter((e) => e.type === "up" && e.button === "left");

  // Segments: split at left downs and at gaps over 500 ms.
  const segments = [];
  let current = [];
  let lastT = null;
  const ordered = [...events].sort((a, b) => a.t - b.t);
  for (const ev of ordered) {
    if (ev.type === "move") {
      if (lastT !== null && ev.t - lastT > 500 && current.length > 0) {
        segments.push({ points: current, terminated: "gap" });
        current = [];
      }
      current.push(ev);
      lastT = ev.t;
    } else if (ev.type === "down" && ev.button === "left") {
      if (current.length > 0) {
        segments.push({ points: current, terminated: "click", click: ev });
        current = [];
      }
      lastT = ev.t;
    }
  }
  if (current.length > 0) segments.push({ points: current, terminated: "end" });

  const usable = [];
  for (const seg of segments) {
    const pts = seg.points;
    if (pts.length < 3) continue;
    const a = pts[0];
    const b = pts[pts.length - 1];
    const D = Math.hypot(b.x - a.x, b.y - a.y);
    if (D < 10) continue;
    let pathLen = 0;
    let maxLat = 0;
    for (let i = 1; i < pts.length; i += 1) {
      pathLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    for (const p of pts) {
      const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (D * D);
      const projX = a.x + t * (b.x - a.x);
      const projY = a.y + t * (b.y - a.y);
      maxLat = Math.max(maxLat, Math.hypot(p.x - projX, p.y - projY));
    }
    usable.push({
      D,
      MT: b.t - a.t,
      lastMoveT: b.t,
      pathLen,
      efficiency: D / Math.max(pathLen, 0.001),
      curvature: maxLat / D,
      n: pts.length,
      click: seg.click ?? null,
      clickOffset:
        seg.click !== undefined && seg.click !== null ? Math.hypot(seg.click.x - b.x, seg.click.y - b.y) : NaN,
    });
  }

  // Fitts regression on click-terminated segments (known intent), else all.
  const fitSet = usable.filter((s) => s.click !== null && s.MT > 20 && s.MT < 5000);
  const regSet = fitSet.length >= MIN_SEGMENTS ? fitSet : usable.filter((s) => s.MT > 20 && s.MT < 5000);
  let fitts = null;
  if (regSet.length >= MIN_SEGMENTS) {
    const ids = regSet.map((s) => Math.log2(1 + (2 * s.D) / 40));
    const mts = regSet.map((s) => s.MT);
    const reg = linReg(ids, mts);
    fitts = { a: clamp(reg.intercept, 0, 400), b: clamp(reg.slope, 40, 300), r2: reg.r2, n: regSet.length };
  }

  // Tremor: residual RMS after a 5-sample moving average, restricted to
  // clean ballistic moves (efficiency >= 0.85) so direction reversals and
  // reading-scrub don't masquerade as hand tremor.
  const tremors = [];
  for (const seg of segments) {
    const pts = seg.points;
    if (pts.length < 10) continue;
    const dur = pts[pts.length - 1].t - pts[0].t;
    if (dur < 150) continue;
    const a0 = pts[0];
    const b0 = pts[pts.length - 1];
    const segD = Math.hypot(b0.x - a0.x, b0.y - a0.y);
    let path = 0;
    for (let i = 1; i < pts.length; i += 1) {
      path += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    if (segD / Math.max(path, 0.001) < 0.85) continue;
    let ss = 0;
    let n = 0;
    for (let i = 2; i < pts.length - 2; i += 1) {
      const ax = (pts[i - 2].x + pts[i - 1].x + pts[i].x + pts[i + 1].x + pts[i + 2].x) / 5;
      const ay = (pts[i - 2].y + pts[i - 1].y + pts[i].y + pts[i + 1].y + pts[i + 2].y) / 5;
      ss += (pts[i].x - ax) ** 2 + (pts[i].y - ay) ** 2;
      n += 1;
    }
    if (n > 0) tremors.push(Math.sqrt(ss / n));
  }

  // Click hold + hover (arrival dwell before click-terminated moves).
  const holds = [];
  for (let i = 0; i < clicks.length; i += 1) {
    const down = clicks[i];
    const up = ups.find((u) => u.t >= down.t);
    if (up !== undefined && up.t - down.t >= 10 && up.t - down.t <= 1000) holds.push(up.t - down.t);
  }
  const hovers = [];
  for (const s of usable) {
    if (s.click === null) continue;
    const gap = s.click.t - s.lastMoveT;
    if (gap >= 0 && gap <= 2000) hovers.push(gap);
  }
  // Correction bursts: short moves right before a click (overshoot fixes).
  const corrections = [];
  for (const s of usable) {
    if (s.click === null) continue;
    if (s.D < 60 && s.click.t - s.lastMoveT < 300) corrections.push(s.D);
  }

  const curv = usable
    .filter((s) => s.efficiency >= 0.7)
    .map((s) => s.curvature)
    .sort((a, b) => a - b);
  const eff = usable.map((s) => s.efficiency).sort((a, b) => a - b);
  return {
    nSegments: usable.length,
    fitts,
    curvatureP10: curv.length ? percentile(curv, 0.1) : NaN,
    curvatureP50: curv.length ? percentile(curv, 0.5) : NaN,
    curvatureP90: curv.length ? percentile(curv, 0.9) : NaN,
    efficiencyMedian: eff.length ? percentile(eff, 0.5) : NaN,
    tremorRms: tremors.length >= 5 ? medianOf(tremors) : NaN,
    nTremor: tremors.length,
    hold: holds.length >= MIN_HOLD ? lognormalFit(holds) : null,
    nHold: holds.length,
    hover: hovers.length >= MIN_PAUSE ? lognormalFit(hovers) : null,
    nHover: hovers.length,
    correctionRate: usable.filter((s) => s.click !== null).length
      ? corrections.length / usable.filter((s) => s.click !== null).length
      : 0,
    correctionMedian: corrections.length ? medianOf(corrections) : NaN,
  };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}
function round2(v) {
  return Math.round(v * 100) / 100;
}
function roundInt(v) {
  return Math.round(v);
}

function buildProfile(kb, mouse) {
  const warnings = [];
  const P = {};
  const set = (key, value, fallback, ok) => {
    if (ok) {
      P[key] = value;
    } else {
      P[key] = fallback;
      warnings.push(`${key}: insufficient data, kept default`);
    }
  };

  if (kb.iki !== null) {
    P.ikiSigma = round2(clamp(kb.iki.sigma, 0.15, 1.2));
    P.ikiFloorMs = roundInt(clamp(kb.ikiP1, 30, 120));
    P.ikiCapMs = roundInt(clamp(kb.ikiP99, 500, 3000));
  } else {
    P.ikiSigma = 0.45;
    P.ikiFloorMs = 60;
    P.ikiCapMs = 2000;
    warnings.push("ikiSigma/ikiFloorMs/ikiCapMs: insufficient data, kept defaults");
  }
  if (kb.dwell !== null) {
    P.dwellMedianMs = roundInt(kb.dwell.median);
    P.dwellSigma = round2(clamp(kb.dwell.sigma, 0.15, 1.0));
  } else {
    P.dwellMedianMs = 85;
    P.dwellSigma = 0.35;
    warnings.push("dwellMedianMs/dwellSigma: insufficient data, kept defaults");
  }
  P.dwellFloorMs = 40;
  P.dwellCapMs = 180;
  if (kb.iki !== null && kb.digraphs.length >= 5) {
    const overall = kb.iki.median;
    const top = kb.digraphs.slice(0, 12);
    const ratios = top.map((d) => d.median / overall).filter((r) => r > 0.3 && r < 1.2);
    P.digraphSpeedup = round2(clamp(ratios.length ? medianOf(ratios) : 0.72, 0.5, 0.95));
  } else {
    P.digraphSpeedup = 0.72;
    warnings.push("digraphSpeedup: insufficient data, kept default");
  }
  set("wordPauseMedianMs", kb.wordPause !== null ? roundInt(kb.wordPause.median) : 120, 120, kb.wordPause !== null);
  P.wordPauseSigma = kb.wordPause !== null ? round2(clamp(kb.wordPause.sigma, 0.2, 1.2)) : 0.6;
  P.wordPauseCapMs = 800;
  set(
    "sentencePauseMedianMs",
    kb.sentencePause !== null ? roundInt(kb.sentencePause.median) : 350,
    350,
    kb.sentencePause !== null,
  );
  P.sentencePauseSigma = kb.sentencePause !== null ? round2(clamp(kb.sentencePause.sigma, 0.2, 1.2)) : 0.7;
  P.sentencePauseFloorMs = 100;
  P.sentencePauseCapMs = 1500;
  set(
    "newlinePauseMedianMs",
    kb.newlinePause !== null ? roundInt(kb.newlinePause.median) : 250,
    250,
    kb.newlinePause !== null,
  );
  P.newlinePauseSigma = kb.newlinePause !== null ? round2(clamp(kb.newlinePause.sigma, 0.2, 1.2)) : 0.6;
  P.newlinePauseFloorMs = 80;
  P.newlinePauseCapMs = 1000;
  if (Number.isFinite(kb.thinkingProb) && kb.nIki >= MIN_IKI) {
    P.thinkingProb = round2(clamp(kb.thinkingProb, 0.01, 0.1));
    P.thinkingPauseMedianMs = roundInt(clamp(Number.isFinite(kb.longPauseMedian) ? kb.longPauseMedian : 500, 250, 1500));
  } else {
    P.thinkingProb = 0.04;
    P.thinkingPauseMedianMs = 500;
    warnings.push("thinkingProb/thinkingPauseMedianMs: insufficient data, kept defaults");
  }
  P.thinkingPauseSigma = 0.6;
  P.thinkingPauseFloorMs = 200;
  P.thinkingPauseCapMs = 1500;

  if (mouse.fitts !== null && mouse.fitts.r2 >= 0.3) {
    P.fittsAMs = roundInt(mouse.fitts.a);
    P.fittsBMs = roundInt(mouse.fitts.b);
  } else {
    P.fittsAMs = 100;
    P.fittsBMs = 120;
    warnings.push(
      `fittsAMs/fittsBMs: insufficient data${mouse.fitts !== null ? ` (R2=${mouse.fitts.r2.toFixed(2)} < 0.30)` : ""}, kept defaults`,
    );
  }
  P.curveMinFraction = round2(clamp(Number.isFinite(mouse.curvatureP10) ? mouse.curvatureP10 : 0.06, 0.0, 0.2));
  P.curveMaxFraction = round2(clamp(Number.isFinite(mouse.curvatureP90) ? mouse.curvatureP90 : 0.3, 0.1, 0.5));
  if (Number.isFinite(mouse.correctionMedian) && mouse.correctionMedian > 2) {
    P.overshootSigmaPx = round1(clamp(mouse.correctionMedian, 4, 30));
  } else {
    P.overshootSigmaPx = 12;
    if (mouse.nSegments >= MIN_SEGMENTS) warnings.push("overshootSigmaPx: no corrections observed, kept default");
  }
  P.overshootMinDistPx = 250;
  // Tremor is not fitted: 8 ms poll quantization + timer coalescing inflate
  // the residual far beyond hand tremor (measured 8+ px RMS on real data).
  // The literature 0.9 px stands until a high-resolution source exists.
  P.tremorAmpPx = 0.9;
  if (Number.isFinite(mouse.tremorRms)) {
    warnings.push(
      `tremorAmpPx: poll data cannot resolve hand tremor (measured RMS ${mouse.tremorRms.toFixed(2)} px is timer noise), kept default`,
    );
  }
  P.tremorFreqMinHz = 8;
  P.tremorFreqMaxHz = 12;
  if (mouse.hover !== null) {
    P.hoverMedianMs = roundInt(mouse.hover.median);
    P.hoverSigma = round2(clamp(mouse.hover.sigma, 0.2, 1.2));
  } else {
    P.hoverMedianMs = 120;
    P.hoverSigma = 0.55;
    warnings.push("hoverMedianMs/hoverSigma: insufficient data, kept defaults");
  }
  P.hoverFloorMs = 40;
  P.hoverCapMs = 500;
  if (mouse.hold !== null) {
    P.holdMedianMs = roundInt(mouse.hold.median);
    P.holdSigma = round2(clamp(mouse.hold.sigma, 0.2, 1.2));
  } else {
    P.holdMedianMs = 75;
    P.holdSigma = 0.5;
    warnings.push("holdMedianMs/holdSigma: insufficient data, kept defaults");
  }
  P.holdFloorMs = 30;
  P.holdCapMs = 300;
  P.clickJitterFraction = 0.18;
  P.naturalWpm = Number.isFinite(kb.wpm) ? Math.round(clamp(kb.wpm, 20, 200)) : 80;
  if (!Number.isFinite(kb.wpm)) warnings.push("naturalWpm: insufficient data, kept default");

  return { profile: P, warnings };
}

function currentDefaults() {
  return {
    fittsAMs: 100,
    fittsBMs: 120,
    curveMinFraction: 0.06,
    curveMaxFraction: 0.3,
    overshootSigmaPx: 12,
    overshootMinDistPx: 250,
    tremorAmpPx: 0.9,
    tremorFreqMinHz: 8,
    tremorFreqMaxHz: 12,
    hoverMedianMs: 120,
    hoverSigma: 0.55,
    hoverFloorMs: 40,
    hoverCapMs: 500,
    holdMedianMs: 75,
    holdSigma: 0.5,
    holdFloorMs: 30,
    holdCapMs: 300,
    ikiSigma: 0.45,
    ikiFloorMs: 60,
    ikiCapMs: 2000,
    dwellMedianMs: 85,
    dwellSigma: 0.35,
    dwellFloorMs: 40,
    dwellCapMs: 180,
    digraphSpeedup: 0.72,
    wordPauseMedianMs: 120,
    wordPauseSigma: 0.6,
    wordPauseCapMs: 800,
    sentencePauseMedianMs: 350,
    sentencePauseSigma: 0.7,
    sentencePauseFloorMs: 100,
    sentencePauseCapMs: 1500,
    newlinePauseMedianMs: 250,
    newlinePauseSigma: 0.6,
    newlinePauseFloorMs: 80,
    newlinePauseCapMs: 1000,
    thinkingProb: 0.04,
    thinkingPauseMedianMs: 500,
    thinkingPauseSigma: 0.6,
    thinkingPauseFloorMs: 200,
    thinkingPauseCapMs: 1500,
    clickJitterFraction: 0.18,
    naturalWpm: 80,
  };
}

const PROFILE_KEY_ORDER = Object.keys(currentDefaults());

function formatProfileBlock(P) {
  const lines = [];
  for (const key of PROFILE_KEY_ORDER) {
    lines.push(`  ${key}: ${typeof P[key] === "number" ? P[key] : JSON.stringify(P[key])},`);
  }
  return lines.join("\n");
}

function applyProfile(P, digraphPairs, wpm) {
  for (const key of PROFILE_KEY_ORDER) {
    if (typeof P[key] !== "number" || !Number.isFinite(P[key])) {
      throw new Error(`refusing to apply: profile field ${key} is not a finite number`);
    }
  }
  let source = readFileSync(POLICY_PATH, "utf-8");
  const blockRe = /\/\/ BEGIN HUMAN PROFILE[\s\S]*?export const HUMAN_PROFILE = \{[\s\S]*?\n\} as const;/;
  if (!blockRe.test(source)) {
    throw new Error("HUMAN PROFILE block markers not found in interactionPolicy.ts");
  }
  const replacement = `// BEGIN HUMAN PROFILE (tuned by scripts/record-human/analyze.mjs --apply; do not hand-edit)
/**
 * Fitted human parameters. Defaults are literature values (136M-keystroke
 * IKI stats, Fitts-law mouse studies); analyze.mjs replaces them with
 * measurements from your own recordings. Shape: every timing sample is
 * lognormal(median, sigma) clamped to [floor, cap]; every trajectory is
 * Bezier + Fitts + overshoot + submovements + tremor (see planMouseMove).
 */
export const HUMAN_PROFILE = {
${formatProfileBlock(P)}
} as const;`;
  source = source.replace(blockRe, () => replacement);
  const wpmRe = /export const HUMANIZE_WPM_DEFAULT = \d+;/;
  source = source.replace(wpmRe, () => `export const HUMANIZE_WPM_DEFAULT = ${wpm};`);
  if (digraphPairs !== null && digraphPairs.length > 0) {
    const setRe = /const FAST_DIGRAPHS = new Set\(\s*"[a-z ]*"\.split\(" "\)\s*,?\s*\)/;
    if (!setRe.test(source)) {
      throw new Error("FAST_DIGRAPHS literal not found in interactionPolicy.ts");
    }
    source = source.replace(setRe, () => `const FAST_DIGRAPHS = new Set(\n  "${digraphPairs.join(" ")}".split(" "),\n)`);
  }
  writeFileSync(POLICY_PATH, source);
}

function main() {
  const rawArgs = process.argv.slice(2);
  const files = rawArgs.filter((a) => !a.startsWith("--"));
  const apply = rawArgs.includes("--apply");
  const dryRun = rawArgs.includes("--dry-run");
  if (files.length === 0) {
    console.error("usage: node scripts/record-human/analyze.mjs <recording.jsonl> [...] [--apply] [--dry-run]");
    process.exit(2);
  }
  const { kb, mouse } = parseFiles(files);
  const kbStats = analyzeKeyboard(kb);
  const mouseStats = analyzeMouse(mouse);
  const { profile, warnings } = buildProfile(kbStats, mouseStats);

  const topDigraphs = kbStats.digraphs.slice(0, 24).map((d) => d.pair);
  const baseDigraphs =
    "th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur wh ec ot ew gh et fr ow ai rl ss tt oo lf mm".split(
      " ",
    );
  const merged = [...topDigraphs];
  for (const pair of baseDigraphs) {
    if (merged.length >= 64) break;
    if (!merged.includes(pair)) merged.push(pair);
  }
  const digraphPairs = kbStats.digraphs.length >= 5 ? merged : null;

  console.log("=== keyboard ===");
  console.log(`presses=${kbStats.nPress} iki_n=${kbStats.nIki} dwell_n=${kbStats.nDwell}`);
  if (kbStats.iki !== null) {
    console.log(
      `IKI lognormal: median=${round1(kbStats.iki.median)}ms sigma=${round2(kbStats.iki.sigma)} p1=${roundInt(kbStats.ikiP1)} p99=${roundInt(kbStats.ikiP99)}`,
    );
  } else {
    console.log("IKI: too few samples (need 50+)");
  }
  if (kbStats.dwell !== null) {
    console.log(`dwell lognormal: median=${round1(kbStats.dwell.median)}ms sigma=${round2(kbStats.dwell.sigma)}`);
  } else {
    console.log("dwell: too few samples (need 50+)");
  }
  console.log(
    `rollover=${(kbStats.rolloverRate * 100).toFixed(1)}% top digraphs=${kbStats.digraphs
      .slice(0, 8)
      .map((d) => `${d.pair}(${d.n},${roundInt(d.median)}ms)`)
      .join(" ")}`,
  );
  if (kbStats.wordPause !== null) console.log(`word pause median=${roundInt(kbStats.wordPause.median)}ms`);
  if (kbStats.sentencePause !== null) console.log(`sentence pause median=${roundInt(kbStats.sentencePause.median)}ms`);
  console.log(
    `wpm=${Number.isFinite(kbStats.wpm) ? round1(kbStats.wpm) : "n/a"} (printable=${kbStats.printable}, active_min=${round2(kbStats.activeMin)})`,
  );

  console.log("=== mouse ===");
  console.log(`segments=${mouseStats.nSegments}`);
  if (mouseStats.fitts !== null) {
    console.log(
      `Fitts: MT = ${roundInt(mouseStats.fitts.a)} + ${roundInt(mouseStats.fitts.b)}*log2(1+2D/40)  R2=${round2(mouseStats.fitts.r2)} n=${mouseStats.fitts.n}`,
    );
  } else {
    console.log("Fitts: too few segments (need 10+)");
  }
  console.log(
    `curvature p10/p50/p90=${round2(mouseStats.curvatureP10)}/${round2(mouseStats.curvatureP50)}/${round2(mouseStats.curvatureP90)} efficiency_med=${round2(mouseStats.efficiencyMedian)}`,
  );
  console.log(
    `tremor_rms=${Number.isFinite(mouseStats.tremorRms) ? round2(mouseStats.tremorRms) : "n/a"}px (n=${mouseStats.nTremor})`,
  );
  if (mouseStats.hold !== null) console.log(`click hold median=${round1(mouseStats.hold.median)}ms (n=${mouseStats.nHold})`);
  if (mouseStats.hover !== null) console.log(`hover median=${round1(mouseStats.hover.median)}ms (n=${mouseStats.nHover})`);
  console.log(
    `correction_rate=${(mouseStats.correctionRate * 100).toFixed(1)}% correction_med=${Number.isFinite(mouseStats.correctionMedian) ? round1(mouseStats.correctionMedian) : "n/a"}px`,
  );

  if (warnings.length > 0) {
    console.log("=== warnings (defaults kept) ===");
    for (const w of warnings) console.log(`- ${w}`);
  }

  mkdirSync(RECORD_DIR, { recursive: true });
  const outPath = path.join(RECORD_DIR, "human-profile.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), files, keyboard: kbStats, mouse: mouseStats, profile },
      null,
      2,
    ),
  );
  console.log(`profile written to ${outPath}`);

  if (dryRun || apply) {
    console.log("=== HUMAN_PROFILE block preview ===");
    console.log(formatProfileBlock(profile));
    console.log(`HUMANIZE_WPM_DEFAULT -> ${profile.naturalWpm}`);
    console.log(`digraph set (${digraphPairs !== null ? digraphPairs.length : "unchanged"} pairs)`);
  }
  if (apply && !dryRun) {
    applyProfile(profile, digraphPairs, profile.naturalWpm);
    console.log(`applied to ${POLICY_PATH} (review with git diff)`);
  }
}

main();
