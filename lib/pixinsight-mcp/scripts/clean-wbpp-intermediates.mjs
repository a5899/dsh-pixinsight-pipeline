#!/usr/bin/env node
// clean-wbpp-intermediates.mjs — delete WBPP's scratch tree, never the masters.
//
// WBPP leaves registered/, calibrated/, debayer/, cache/, logs/ and per-frame .xisf
// next to the masters. That tree dwarfs the masters and is rebuilt by any re-run, so
// it is scratch — but deleting it unprompted is not on the table. This script:
//   * defaults to --dry-run (reports, deletes nothing)
//   * requires --yes to actually delete
//   * refuses to run unless it can see a master it would be preserving
//   * never follows a path outside --dir
//
// Usage:
//   node clean-wbpp-intermediates.mjs --dir "<material folder>\wbpp" [--dry-run|--yes]
//                                     [--max-depth N] [--keep-logs]
//
// Exit codes:
//   0  ok (dry-run report, or deletion completed)
//   1  bad arguments / directory missing
//   2  refused (no master found to protect, or unsafe path)
//   4  deletion finished with errors (listed in the JSON)

import fs from 'node:fs';
import path from 'node:path';

const IMAGE_EXT = new Set(['.xisf', '.fit', '.fits', '.fts', '.tif', '.tiff']);

// Directories WBPP creates for intermediate work. Anything else is left alone
// unless it is empty and matched by EMPTY_PRUNE below.
const INTERMEDIATE_DIRS = new Set([
  'registered',
  'calibrated',
  'debayer',
  'cache',
  'logs',
  'fastintegration',
  'registered-pixelinterpolation',
  'integration',
  'processing',
  'tmp',
  'autocrop',
]);

// Never delete these, whatever the tree looks like.
const PROTECTED_DIRS = new Set(['master', 'masters', 'deliverables', '_history']);
const PROTECTED_FILE_RE = /^(master|integration|masterlight)/i;

function realSafe(child, root) {
  const rel = path.relative(root, child);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      try { bytes += fs.statSync(full).size; files++; } catch { /* raced */ }
    }
  }
  return { bytes, files };
}

function parseArgs(argv) {
  const args = { dir: null, dryRun: true, keepLogs: false, maxDepth: 6 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--max-depth') args.maxDepth = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--yes' || a === '--delete') args.dryRun = false;
    else if (a === '--keep-logs') args.keepLogs = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv);
if (args.help || !args.dir) {
  console.error('usage: node clean-wbpp-intermediates.mjs --dir "<wbpp dir>" [--dry-run|--yes] [--keep-logs]');
  process.exit(1);
}

const root = path.resolve(args.dir);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`directory not found: ${root}`);
  process.exit(1);
}

// --- safety gate: there must be a *light* master here to protect ------------
// Cleaning a folder that has no light master is how you delete someone's only output.
// A calibration master does not count: it is not what the pipeline needs, so its
// presence must not unlock deletion.
const CALIB_RE = /(?:master)?(?:bias|darkflat|flatdark|dark|flat)(?![a-z])/i;

function findMasters(dir, depth = 0) {
  const found = [];
  if (depth > args.maxDepth) return found;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (INTERMEDIATE_DIRS.has(e.name.toLowerCase())) continue;
      found.push(...findMasters(full, depth + 1));
      continue;
    }
    if (!e.isFile()) continue;
    if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    if (CALIB_RE.test(e.name)) continue;            // calibration is never the protectee
    if (!/master/i.test(e.name)) continue;
    found.push(full);
  }
  return found;
}

const masters = findMasters(root);
if (masters.length === 0) {
  console.log(JSON.stringify({
    ok: false,
    refused: 'no-master-found',
    dir: root,
    message: 'No master file found under this directory — refusing to delete anything. ' +
      'Point --dir at the WBPP work tree (<material>\\wbpp) whose master/ you want preserved.',
  }, null, 2));
  process.exit(2);
}

// --- plan ------------------------------------------------------------------
const plan = [];
let stack = [{ dir: root, depth: 0 }];
while (stack.length) {
  const { dir, depth } = stack.pop();
  if (depth > args.maxDepth) continue;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (!realSafe(full, root)) continue;
    const lower = e.name.toLowerCase();
    if (e.isDirectory()) {
      if (PROTECTED_DIRS.has(lower)) continue;
      if (INTERMEDIATE_DIRS.has(lower)) {
        if (args.keepLogs && lower === 'logs') { stack.push({ dir: full, depth: depth + 1 }); continue; }
        const { bytes, files } = dirSize(full);
        plan.push({ type: 'dir', path: full, relPath: path.relative(root, full), bytes, files });
        continue; // whole dir is scratch; do not descend into it
      }
      stack.push({ dir: full, depth: depth + 1 });
      continue;
    }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    if (PROTECTED_FILE_RE.test(e.name)) continue;
    // A stray per-frame image outside the known scratch dirs is still intermediate;
    // it is only kept when it looks like a master.
    if (/master/i.test(e.name) && !/bias|dark|flat/i.test(e.name)) continue;
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    plan.push({ type: 'file', path: full, relPath: path.relative(root, full), bytes: st.size, files: 1 });
  }
}

const totalBytes = plan.reduce((s, p) => s + p.bytes, 0);
const totalFiles = plan.reduce((s, p) => s + p.files, 0);

const report = {
  ok: true,
  dryRun: args.dryRun,
  dir: root,
  mastersPreserved: masters.map((m) => path.relative(root, m)),
  reclaim: { bytes: totalBytes, mib: Number((totalBytes / 1024 / 1024).toFixed(1)), files: totalFiles },
  targets: plan.map(({ type, relPath, bytes, files }) => ({ type, relPath, mib: Number((bytes / 1024 / 1024).toFixed(1)), files })),
};

if (args.dryRun) {
  report.message = `dry-run: would reclaim ${report.reclaim.mib} MiB (${totalFiles} files) across ${plan.length} target(s); ` +
    `${masters.length} master(s) preserved. Re-run with --yes to delete.`;
} else {
  const errors = [];
  for (const p of plan) {
    try {
      if (p.type === 'dir') fs.rmSync(p.path, { recursive: true, force: true });
      else fs.unlinkSync(p.path);
    } catch (err) {
      errors.push({ path: p.relPath, error: String(err && err.message ? err.message : err) });
    }
  }
  report.errors = errors;
  if (errors.length) {
    report.ok = false;
    report.message = `deleted with ${errors.length} error(s); reclaimed up to ${report.reclaim.mib} MiB; ` +
      `${masters.length} master(s) preserved.`;
  } else {
    report.message = `reclaimed ${report.reclaim.mib} MiB (${totalFiles} files); ${masters.length} master(s) preserved.`;
  }
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 4);
