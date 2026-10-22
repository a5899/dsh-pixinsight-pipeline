// Behavioural tests for the WBPP-side scripts: find-masters, clean-wbpp-intermediates,
// resolve-toolkit. These are the parts that decide whether the agent re-stacks data or
// deletes files, so they get real temp-directory fixtures instead of mocks.
//
// Run: node test\scripts.mjs   (also part of `npm test`)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mkScript = (rel) => path.join(root, 'lib', 'pixinsight-mcp', 'scripts', rel);
const FIND = mkScript('find-masters.mjs');
const CLEAN = mkScript('clean-wbpp-intermediates.mjs');
const RESOLVE = mkScript('resolve-toolkit.mjs');

let passed = 0;
const failures = [];

function test(name, fn) {
  const dirs = [];
  try {
    fn(dirs);
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`FAIL ${name}\n     ${err.message}`);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

/** Run a script, returning { code, stdout, stderr }. Never throws on non-zero exit. */
function run(script, args) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : -1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

function runJson(script, args) {
  const r = run(script, args);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* caller asserts on json */ }
  return { ...r, json };
}

/** Temp material folder with a WBPP-style layout. */
function fixture(dirs, { masters = true, calibration = true, workTree = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-test-'));
  dirs.push(base);
  const wbpp = path.join(base, 'wbpp');
  const master = path.join(wbpp, 'master');
  fs.mkdirSync(master, { recursive: true });
  fs.mkdirSync(path.join(base, 'lights'), { recursive: true });

  if (masters) {
    // Nested one level down on purpose: a flat ls must not be treated as a search.
    fs.mkdirSync(path.join(master, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(master, 'deep', 'masterLight_BIN-1_FILTER-OIII.xisf'), 'x'.repeat(3000));
    fs.writeFileSync(path.join(master, 'masterLight_BIN-1_EXPTIME-300s_FILTER-Ha.xisf'), 'x'.repeat(5000));
  }
  if (calibration) {
    fs.writeFileSync(path.join(master, 'masterDark_300s.xisf'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(master, 'masterFlat_Ha.xisf'), 'x'.repeat(800));
  }
  fs.writeFileSync(path.join(base, 'lights', 'frame001.fit'), 'x'.repeat(400));

  if (workTree) {
    fs.mkdirSync(path.join(wbpp, 'registered'), { recursive: true });
    fs.mkdirSync(path.join(wbpp, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(wbpp, 'registered', 'frame001_r.xisf'), 'x'.repeat(700));
    fs.writeFileSync(path.join(wbpp, 'cache', 'tmp.bin'), 'x'.repeat(900));
  }
  return { base, wbpp, master };
}

// ---------------------------------------------------------------- find-masters

test('find-masters: ready, finds nested master and ignores calibration', (dirs) => {
  const { base } = fixture(dirs);
  const { code, json } = runJson(FIND, ['--dir', base]);
  assert.equal(code, 0);
  assert.equal(json.verdict, 'ready');
  const names = json.candidates.map((c) => path.basename(c.path)).sort();
  assert.deepEqual(names, [
    'masterLight_BIN-1_EXPTIME-300s_FILTER-Ha.xisf',
    'masterLight_BIN-1_FILTER-OIII.xisf',
  ]);
  // masterFlat / masterDark must never be offered as pipeline input.
  assert.ok(!json.candidates.some((c) => /flat|dark|bias/i.test(c.path)));
});

test('find-masters: channels parsed from FILTER markers, not from EXPTIME digits', (dirs) => {
  const { base } = fixture(dirs, { calibration: false, workTree: false });
  const { json } = runJson(FIND, ['--dir', base]);
  const ha = json.candidates.find((c) => c.path.includes('FILTER-Ha'));
  const oiii = json.candidates.find((c) => c.path.includes('FILTER-OIII'));
  assert.deepEqual(ha.channelsPresent, ['HA'], 'EXPTIME-300s must not yield SII');
  assert.deepEqual(oiii.channelsPresent, ['OIII']);
});

test('find-masters: only_calibration when no light master', (dirs) => {
  const { base } = fixture(dirs, { masters: false });
  const { code, json } = runJson(FIND, ['--dir', base]);
  assert.equal(code, 0);
  assert.equal(json.verdict, 'only_calibration');
  assert.equal(json.candidates.length, 0);
});

test('find-masters: none on an empty folder', (dirs) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-empty-'));
  dirs.push(base);
  const { json } = runJson(FIND, ['--dir', base]);
  assert.equal(json.verdict, 'none');
});

test('find-masters: missing folder exits 1', () => {
  const { code } = run(FIND, ['--dir', path.join(os.tmpdir(), 'pi-does-not-exist-xyz')]);
  assert.equal(code, 1);
});

// ------------------------------------------------------- clean-wbpp-intermediates

test('clean: defaults to dry-run and deletes nothing', (dirs) => {
  const { wbpp } = fixture(dirs);
  const { code, json } = runJson(CLEAN, ['--dir', wbpp]);
  assert.equal(code, 0);
  assert.equal(json.dryRun, true);
  assert.ok(fs.existsSync(path.join(wbpp, 'registered')), 'dry-run must not delete');
  assert.ok(fs.existsSync(path.join(wbpp, 'cache')));
  assert.ok(json.reclaim.files >= 2);
});

test('clean: --yes removes scratch and preserves every master', (dirs) => {
  const { wbpp, master } = fixture(dirs);
  const before = fs.readdirSync(master, { recursive: true }).length;
  const { code, json } = runJson(CLEAN, ['--dir', wbpp, '--yes']);
  assert.equal(code, 0);
  assert.deepEqual(json.errors, []);
  assert.ok(!fs.existsSync(path.join(wbpp, 'registered')), 'registered/ should be gone');
  assert.ok(!fs.existsSync(path.join(wbpp, 'cache')), 'cache/ should be gone');
  const after = fs.readdirSync(master, { recursive: true }).length;
  assert.equal(after, before, 'master/ contents must be untouched');
});

test('clean: refuses (exit 2) when only calibration masters exist', (dirs) => {
  const { base } = fixture(dirs, { masters: false });
  const { code, json } = runJson(CLEAN, ['--dir', base, '--yes']);
  assert.equal(code, 2);
  assert.equal(json.refused, 'no-master-found');
  // Nothing may have been removed while refusing.
  assert.ok(fs.existsSync(path.join(base, 'wbpp', 'registered')));
});

test('clean: --keep-logs retains the logs directory', (dirs) => {
  const { wbpp } = fixture(dirs);
  fs.mkdirSync(path.join(wbpp, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(wbpp, 'logs', 'run.log'), 'log');
  const { code } = run(CLEAN, ['--dir', wbpp, '--yes', '--keep-logs']);
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(wbpp, 'logs', 'run.log')), '--keep-logs must keep logs/');
  assert.ok(!fs.existsSync(path.join(wbpp, 'registered')));
});

// -------------------------------------------------------------- resolve-toolkit

test('resolve-toolkit: --check finds this package and reports per-file presence', () => {
  const { code, json } = runJson(RESOLVE, ['--check']);
  assert.equal(code, 0, 'resolver should find the package it ships in');
  assert.equal(json.ok, true);
  for (const key of ['piTool', 'watcher', 'wbppWrapper', 'findMasters', 'cleanWbpp']) {
    assert.equal(json.checks[key], true, `${key} should be present: ${JSON.stringify(json.checks)}`);
  }
  assert.ok(fs.existsSync(json.checks.toolkit), 'toolkit root must exist');
});

test('resolve-toolkit: --sub resolves a real tool path', () => {
  const { code, stdout } = run(RESOLVE, ['--sub', path.join('scripts', 'pi-tool.mjs')]);
  assert.equal(code, 0);
  assert.ok(fs.existsSync(stdout.trim()), `resolved path should exist: ${stdout.trim()}`);
});

test('resolve-toolkit: --sub on a missing file exits 1', () => {
  const { code } = run(RESOLVE, ['--sub', path.join('scripts', 'no-such-tool.mjs')]);
  assert.equal(code, 1);
});

// ---------------------------------------------------------------------- summary

if (failures.length) {
  console.error(`\n${failures.length} test(s) failed, ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`\nall ${passed} script tests passed`);
}
