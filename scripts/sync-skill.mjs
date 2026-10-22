#!/usr/bin/env node
// sync-skill.mjs — keep the two copies of the pixinsight-pipeline skill in step.
//
// There are two live copies and they drift silently:
//   A) user skill root   <DSH_HOME>\skills\pixinsight-pipeline\   (loaded directly by DSH)
//   B) package bundle    <repo>\packages\dsh-pixinsight-pipeline\skills\pixinsight-pipeline\
//
// They are NOT identical by design — the package copy uses `%DSH_HOME%`/`<plugin>` paths
// while the user copy may use absolute workspace paths. So this tool never blindly copies:
// by default it only REPORTS the differences, and `--direction` copies one way after you
// have decided which side is authoritative.
//
// Usage:
//   node sync-skill.mjs                          # status: diff summary of both copies
//   node sync-skill.mjs --diff                   # full unified diff (files that differ)
//   node sync-skill.mjs --to-package             # user copy  -> package copy
//   node sync-skill.mjs --to-user                # package copy -> user copy
//   node sync-skill.mjs --dry-run --to-package   # show what would be copied
//   node sync-skill.mjs --check                  # same, but quiet when in sync (gate form)
//
// Exit codes: 0 in sync / copy ok, 1 differences found or copy failed, 2 bad use.
// Reporting modes exit 1 on drift, so the tool is usable as a gate either way.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = { diff: false, dryRun: false, check: false, to: null };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--diff') a.diff = true;
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--check') a.check = true;
    else if (v === '--to-package') a.to = 'package';
    else if (v === '--to-user') a.to = 'user';
    else if (v === '--help' || v === '-h') a.help = true;
  }
  return a;
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** Walk up looking for the package's skills/pixinsight-pipeline. */
function findPackageSkill() {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const p = path.join(dir, 'skills', 'pixinsight-pipeline');
    if (fs.existsSync(path.join(p, 'SKILL.md'))) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const USER_SKILL = path.join(dshHome(), 'skills', 'pixinsight-pipeline');
const PKG_SKILL = findPackageSkill();

const args = parseArgs(process.argv);
if (args.help) {
  console.error('usage: node sync-skill.mjs [--diff] [--check] [--to-user|--to-package] [--dry-run]');
  process.exit(2);
}

if (!PKG_SKILL) {
  console.error('package skill copy not found (looked for skills/pixinsight-pipeline above ' + HERE + ')');
  process.exit(2);
}
// A missing user copy is not drift — it means the skill was never installed that way
// (a plugin-only install is legitimate). Status/check must not fail on it, otherwise
// `npm test` goes red on a machine that simply uses the package instead.
if (!fs.existsSync(path.join(USER_SKILL, 'SKILL.md'))) {
  if (args.to === 'package') {
    console.error(`user skill copy not found: ${USER_SKILL}`);
    console.error('Nothing to copy from. Install it first (scripts\\install-into-dsh.ps1).');
    process.exit(2);
  }
  console.log(`user skill copy not found: ${USER_SKILL}`);
  console.log('Nothing installed at that path, so there is no drift to check.');
  console.log('(A plugin-only install is legitimate; run scripts\\install-into-dsh.ps1 to add the');
  console.log(' skill-root copy, or set DSH_HOME if it lives elsewhere.)');
  process.exit(0);
}

/**
 * All files under a skill dir, as relative paths.
 * Editor swap files, OS metadata and anything that looks like a backup are skipped:
 * they are not part of the skill and would otherwise show up as phantom drift.
 */
const IGNORED = /(^|[\\/])(\.DS_Store|Thumbs\.db|node_modules)([\\/]|$)|\.(bak|bak-[\w.-]+|tmp|swp|orig)$|~$/i;

function listFiles(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(root, full);
      if (IGNORED.test(rel)) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

const userFiles = new Set(listFiles(USER_SKILL));
const pkgFiles = new Set(listFiles(PKG_SKILL));
const allFiles = [...new Set([...userFiles, ...pkgFiles])].sort();

const rows = [];
for (const rel of allFiles) {
  const u = path.join(USER_SKILL, rel);
  const p = path.join(PKG_SKILL, rel);
  const hasU = userFiles.has(rel);
  const hasP = pkgFiles.has(rel);
  if (!hasU) { rows.push({ rel, state: 'only-package' }); continue; }
  if (!hasP) { rows.push({ rel, state: 'only-user' }); continue; }
  const same = fs.readFileSync(u).equals(fs.readFileSync(p));
  rows.push({ rel, state: same ? 'same' : 'differ' });
}

const differing = rows.filter((r) => r.state !== 'same');

// --- copy mode -------------------------------------------------------------
if (args.to) {
  const [src, dst, label] =
    args.to === 'package'
      ? [USER_SKILL, PKG_SKILL, 'user -> package']
      : [PKG_SKILL, USER_SKILL, 'package -> user'];

  const plan = [];
  for (const rel of listFiles(src)) {
    const s = path.join(src, rel);
    const d = path.join(dst, rel);
    const exists = fs.existsSync(d);
    const same = exists && fs.readFileSync(s).equals(fs.readFileSync(d));
    if (!same) plan.push({ rel, action: exists ? 'overwrite' : 'create' });
  }

  if (plan.length === 0) {
    console.log(`[${label}] already identical — nothing to copy (${listFiles(src).length} files).`);
    process.exit(0);
  }
  if (args.dryRun) {
    console.log(`[${label}] dry-run, would update ${plan.length} file(s):`);
    for (const p of plan) console.log(`  ${p.action.padEnd(9)} ${p.rel}`);
    process.exit(0);
  }

  let failed = 0;
  for (const p of plan) {
    const s = path.join(src, p.rel);
    const d = path.join(dst, p.rel);
    try {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      console.log(`  ${p.action.padEnd(9)} ${p.rel}`);
    } catch (err) {
      failed++;
      console.error(`  FAILED    ${p.rel}: ${err.message}`);
    }
  }
  console.log(`[${label}] ${plan.length - failed} updated, ${failed} failed.`);
  console.log('Note: files deleted on the source side are NOT removed from the destination.');
  process.exit(failed ? 1 : 0);
}

// --- status / check / diff -------------------------------------------------
console.log(`user copy : ${USER_SKILL}`);
console.log(`pkg  copy : ${PKG_SKILL}`);
console.log('');

if (differing.length === 0) {
  console.log(`IN SYNC — ${rows.length} file(s) identical.`);
  process.exit(0);
}

console.log(`${differing.length} of ${rows.length} file(s) differ:`);
for (const r of differing) console.log(`  ${r.state.padEnd(13)} ${r.rel}`);

if (args.diff) {
  for (const r of differing) {
    if (r.state !== 'differ') continue;
    const u = path.join(USER_SKILL, r.rel);
    const p = path.join(PKG_SKILL, r.rel);
    console.log(`\n===== ${r.rel} (--- user / +++ package) =====`);
    const run = (file, tag) => {
      const text = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      return text.map((line) => `${tag}${line}`);
    };
    // A tiny line-oriented diff: enough to see drift, no dependency needed.
    const a = run(u, '- ');
    const b = run(p, '+ ');
    const setB = new Set(b);
    const setA = new Set(a);
    for (const line of a) if (!setB.has(line)) console.log(line);
    for (const line of b) if (!setA.has(line)) console.log(line);
  }
}

console.log('');
console.log('Resolve with one of:');
console.log('  node sync-skill.mjs --to-package    # user copy is authoritative');
console.log('  node sync-skill.mjs --to-user       # package copy is authoritative');
console.log('');
console.log('Exit code 1 means the copies differ, so this works as a gate with or without --check.');

// Drift is a non-zero result in every mode — dropping --check must not turn a broken
// state into a green one.
process.exit(1);
