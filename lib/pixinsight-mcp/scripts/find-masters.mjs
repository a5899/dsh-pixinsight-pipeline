#!/usr/bin/env node
// find-masters.mjs — locate a usable light master inside a material folder.
//
// Motivation: the pipeline used to ask the user "run WBPP?" before looking for an
// existing master. The master is normally already in the material folder, and a
// spurious WBPP run overwrites good masters with intermediate files.
//
// Usage:
//   node find-masters.mjs --dir "<material folder>" [--json] [--max-depth N]
//
// Exit codes:
//   0  verdict=ready | only_calibration | none   (a verdict was produced)
//   1  bad arguments / directory missing
//
// Output (stdout, JSON unless --json is omitted):
//   { ok, dir, verdict, frameCount, candidates: [...], calibration: [...], message }

import fs from 'node:fs';
import path from 'node:path';

const IMAGE_EXT = new Set(['.xisf', '.fit', '.fits', '.fts', '.tif', '.tiff']);

// --- classification -------------------------------------------------------

// Calibration masters are never the pipeline input: they are inputs *to* WBPP.
// Note `master` and the frame type are glued together in real filenames
// (`masterFlat_...`, `masterDark_...`), so no separator may be required between them.
const CAL_RE = /(?:master)?(?:bias|darkflat|flatdark|dark|flat)(?![a-z])/i;

// Light-master markers. WBPP writes `masterLight_BIN-1_..._EXPTIME-...xisf`;
// other stacks use integrated/integration/stack/result naming.
const LIGHT_MASTER_RE =
  /(master[_\-]?light|masterlight|light[_\-]?master|integrat|stacked|(?:^|[_\-.\s])stack(?:[_\-.\s]|$)|(?:^|[_\-.\s])result(?:[_\-.\s]|$)|drizzle)/i;

// Anything that is only a working copy, not the stack itself.
const PREVIEW_RE = /(preview|thumb|_small|screenshot)/i;

// Filter/band token → canonical channel name.
const BANDS = {
  H: 'HA', HA: 'HA', HALPHA: 'HA',
  OIII: 'OIII', O3: 'OIII',
  SII: 'SII', S2: 'SII',
  L: 'L', LUM: 'L', LUMINANCE: 'L',
  R: 'R', RED: 'R',
  G: 'G', GREEN: 'G',
  B: 'B', BLUE: 'B',
};

function channelsPresent(name) {
  const base = path.basename(name, path.extname(name)).toUpperCase();
  const chans = new Set();
  // Filter markers are usually glued to a keyword (`FILTER-Ha`, `FILTER-OIII`). Read those
  // first and drop them from the string, so `EXPTIME-300s` cannot contribute a stray `S`
  // and `BIN-1` cannot contribute a stray `B`.
  const FILTER_RE = /(?:FILTER|BAND|CHANNEL)[-_ ]?([A-Z0-9]+)/gi;
  let rest = base;
  let m;
  while ((m = FILTER_RE.exec(base)) !== null) {
    const tok = m[1].toUpperCase();
    const band = BANDS[tok];
    if (band) chans.add(band);
  }
  rest = base.replace(FILTER_RE, ' ');

  // Remaining tokens: only trust standalone band words, never a digit-adjacent letter
  // (`300S`) and never a letter glued to a number.
  for (const part of rest.split(/[^A-Z]+/)) {
    if (!part) continue;
    if (part.length === 1) {
      // Bare single letters are ambiguous; accept only `L` in an obvious luminance name.
      if (part === 'L' && /LUM|_L[_\-.]|LUMINANCE/.test(base)) chans.add('L');
      continue;
    }
    const band = BANDS[part];
    if (band) chans.add(band);
  }
  // OSC detection: a debayer/CFA marker means the master carries RGB in one file.
  if (/CFA|DEBAYER|OSC|RCBW|ONE[\s_-]?SHOT/.test(base)) { chans.add('RGB'); }
  return [...chans].sort();
}

function classify(file) {
  const name = path.basename(file);
  const ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return null;

  if (CAL_RE.test(name.replace(path.extname(name), ''))) {
    return { kind: 'calibration', reason: 'calibration-master' };
  }
  if (PREVIEW_RE.test(name)) {
    return { kind: 'preview', reason: 'preview-file' };
  }
  if (LIGHT_MASTER_RE.test(name)) {
    return { kind: 'master', reason: 'light-master-name' };
  }
  return { kind: 'raw-or-other', reason: 'unclassified' };
}

// Ranking within a kind: master > preview > raw-or-other; then newer; then larger.
const KIND_RANK = { master: 0, preview: 1, 'raw-or-other': 2 };

// --- scan -----------------------------------------------------------------

function walk(root, maxDepth) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) throw err;
      continue; // unreadable subfolder is not fatal
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      const cls = classify(full);
      if (!cls) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      out.push({
        path: full,
        relPath: path.relative(root, full),
        kind: cls.kind,
        reason: cls.reason,
        channelsPresent: channelsPresent(e.name),
        sizeBytes: st.size,
        mtime: st.mtime.toISOString(),
        depth,
      });
    }
  }
  return out;
}

// --- main -----------------------------------------------------------------

function parseArgs(argv) {
  const args = { dir: null, json: true, maxDepth: 6 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--max-depth') args.maxDepth = Number(argv[++i]);
    else if (a === '--text') args.json = false;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv);
if (args.help || !args.dir) {
  console.error('usage: node find-masters.mjs --dir "<material folder>" [--json|--text] [--max-depth N]');
  process.exit(1);
}

const root = path.resolve(args.dir);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`material folder not found: ${root}`);
  process.exit(1);
}

const all = walk(root, args.maxDepth);
const masters = all.filter((f) => f.kind === 'master');
const calibration = all.filter((f) => f.kind === 'calibration');
const rawFrames = all.filter((f) => f.kind === 'raw-or-other');
const previews = all.filter((f) => f.kind === 'preview');

const sortFn = (a, b) =>
  (KIND_RANK[a.kind] - KIND_RANK[b.kind]) ||
  (b.mtime.localeCompare(a.mtime)) ||
  (b.sizeBytes - a.sizeBytes);
masters.sort(sortFn);

let verdict;
if (masters.length > 0) verdict = 'ready';
else if (calibration.length > 0) verdict = 'only_calibration';
else verdict = 'none';

// A one-line message the agent can quote to the user without re-deriving it.
let message;
if (verdict === 'ready') {
  const top = masters[0];
  const chans = [...new Set(masters.flatMap((m) => m.channelsPresent))].sort();
  message = `found ${masters.length} light master(s) in ${path.basename(root)}; top candidate ${top.relPath}` +
    (chans.length ? ` (channels: ${chans.join('/')})` : '');
} else if (verdict === 'only_calibration') {
  message = `no light master in ${path.basename(root)} (${calibration.length} calibration file(s), ${rawFrames.length} other frame(s)); WBPP is needed`;
} else {
  message = `no master-class file in ${path.basename(root)} (${rawFrames.length} frame(s) seen); WBPP is needed`;
}

const result = {
  ok: true,
  dir: root,
  verdict,
  frameCount: rawFrames.length,
  candidates: masters,
  calibration: calibration.map((c) => ({ path: c.path, relPath: c.relPath, sizeBytes: c.sizeBytes })),
  previews: previews.map((p) => ({ path: p.path, relPath: p.relPath })),
  message,
};

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`${verdict.toUpperCase()}: ${message}`);
  for (const m of masters) {
    const mb = (m.sizeBytes / 1024 / 1024).toFixed(1);
    console.log(`  master  ${m.relPath}  [${m.channelsPresent.join('/') || '?'}]  ${mb} MB  ${m.mtime}`);
  }
  for (const c of calibration) {
    console.log(`  calib   ${c.relPath}  ${(c.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  }
}
