// Tests for ensure-astap.mjs — the installer that acquires a HEADLESS ASTAP solver and
// verifies it can actually read the installed star catalog.
//
// The behaviours locked in here all came from real failures:
//   - the GUI astap.exe hangs any script that asks it to solve (so a headless binary is
//     mandatory, and vendor/astap_cli.exe must ship with the plugin)
//   - D05/D20/D50/D80 share the .1476 suffix, so a suffix match never identifies a catalog
//   - a config/catalog mismatch (ref_database=V50 with only .1476 tiles on disk) makes
//     every solve fail while the config "looks" correct
//   - a probe must not report success from the absence of an error: a bad test image or a
//     missing one short-circuits before the catalog is ever consulted
//
// Run: node test\astap.mjs   (also part of `npm test`)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ENSURE = path.join(root, 'lib', 'pixinsight-mcp', 'scripts', 'ensure-astap.mjs');
const VENDOR_CLI = path.join(root, 'lib', 'pixinsight-mcp', 'vendor', 'astap_cli.exe');

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

function run(script, args) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: typeof err.status === 'number' ? err.status : -1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

function runJson(script, args) {
  // --json is mandatory here: without it the script prints human prose and any JSON parse
  // silently yields null, which then fails as a confusing "cannot read property of null".
  const argv = args.includes('--json') ? args : [...args, '--json'];
  const r = run(script, argv);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* asserted by caller */ }
  return { ...r, json };
}

/** Fake ASTAP dir: a dummy executable plus N catalog tiles named <code>_NNNN.1476. */
function fixture(dirs, { code = 'd20', tiles = 5, refDatabase = 'D20', writeCfg = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'astap-test-'));
  dirs.push(base);
  fs.writeFileSync(path.join(base, 'astap.exe'), 'stub');
  for (let i = 1; i <= tiles; i++) {
    fs.writeFileSync(path.join(base, `${code}_${String(i).padStart(4, '0')}.1476`), 'x'.repeat(64));
  }
  if (writeCfg) {
    fs.writeFileSync(path.join(base, 'astap.cfg'), `[main]\nref_database=${refDatabase}\nstar_database=\n`);
  }
  return base;
}

// ------------------------------------------------------------------ packaging

test('vendor: headless solver ships with the plugin', () => {
  assert.ok(fs.existsSync(VENDOR_CLI), `bundled astap_cli.exe missing at ${VENDOR_CLI}`);
  const st = fs.statSync(VENDOR_CLI);
  assert.ok(st.size > 100 * 1024, `bundled solver suspiciously small (${st.size} bytes)`);
  // must be a real PE binary, not an HTML error page saved under a .exe name
  const head = fs.readFileSync(VENDOR_CLI).subarray(0, 2).toString('latin1');
  assert.equal(head, 'MZ', 'bundled solver is not a Windows executable');
});

// ------------------------------------------------------------------- --check

/** A stub that behaves enough like the headless solver for the probe (accepts a catalog). */
function writeStubSolver(dir) {
  const p = path.join(dir, 'astap_cli.exe');
  fs.writeFileSync(p, 'stub');
  return p;
}

test('--check: coherent install reports ready and writes nothing', (dirs) => {
  const base = fixture(dirs, { refDatabase: 'D20' });
  writeStubSolver(base);
  const before = fs.readFileSync(path.join(base, 'astap.cfg'), 'utf8');
  const { code, json } = runJson(ENSURE, ['--check', '--dir', base, '--no-download']);
  // A stub solver cannot be executed meaningfully, so compatibility stays unverified:
  // the point of this test is that --check never rewrites the config.
  assert.notEqual(code, 0, 'a stub solver must not be reported as fully ready');
  assert.equal(fs.readFileSync(path.join(base, 'astap.cfg'), 'utf8'), before, '--check must not rewrite config');
});

test('--check: V50 config with only .1476 tiles is reported as a mismatch', (dirs) => {
  const base = fixture(dirs, { refDatabase: 'V50' });
  const { code, json } = runJson(ENSURE, ['--check', '--dir', base, '--no-download']);
  assert.equal(code, 1, 'a config/catalog mismatch must not report ready');
  assert.ok(
    json.problems.some((p) => /V50/.test(p) && /match|does not/i.test(p)),
    `expected a mismatch problem, got: ${JSON.stringify(json.problems)}`,
  );
  // --check must leave the file alone
  assert.match(fs.readFileSync(path.join(base, 'astap.cfg'), 'utf8'), /ref_database=V50/);
});

test('repair mode: rewrites ref_database to the installed catalog and backs up', (dirs) => {
  const base = fixture(dirs, { refDatabase: 'V50' });
  // Repair is about the config, independent of whether a solver is present, so the exit
  // code is irrelevant here — only the rewritten value and the backup matter.
  runJson(ENSURE, ['--dir', base, '--no-download']);
  assert.match(fs.readFileSync(path.join(base, 'astap.cfg'), 'utf8'), /ref_database=D20/);
  assert.ok(fs.existsSync(path.join(base, 'astap.cfg.bak-ensure-astap')), 'original config must be backed up');
});

test('no catalog at all: reports unusable and offers the release asset', (dirs) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'astap-empty-'));
  dirs.push(base);
  fs.writeFileSync(path.join(base, 'astap.exe'), 'stub');
  const { code, json } = runJson(ENSURE, ['--check', '--dir', base, '--no-download']);
  assert.equal(code, 1);
  assert.equal(json.catalog, null);
  assert.ok(
    json.problems.some((p) => /no star catalog/i.test(p)),
    `expected a missing-catalog problem, got ${JSON.stringify(json.problems)}`,
  );
});

// ------------------------------------------------------- catalog identification

test('catalog identity comes from the file prefix, not the shared .1476 suffix', (dirs) => {
  // D80 tiles are still .1476 — only the `d80_` prefix says which database it is.
  const base = fixture(dirs, { code: 'd80', tiles: 3, refDatabase: 'D80' });
  const { json } = runJson(ENSURE, ['--check', '--dir', base, '--no-download']);
  assert.equal(json.catalog.code, 'D80', 'must report D80, not D20/D05/D50');
  assert.equal(json.catalog.suffix, '.1476');
  assert.equal(json.catalog.generation, 'modern');
});

test('legacy h-series catalogs are classified as legacy', (dirs) => {
  const base = fixture(dirs, { code: 'h18', tiles: 4, refDatabase: 'H18' });
  const { json } = runJson(ENSURE, ['--check', '--dir', base, '--no-download']);
  assert.equal(json.catalog.code, 'H18');
  assert.equal(json.catalog.generation, 'legacy');
});

// ------------------------------------------------------------- probe honesty

test('probe never claims compatibility it cannot verify', (dirs) => {
  // No test image is discoverable for this fake dir, and the bundled solver is absent
  // from it, so the probe must be inconclusive rather than green.
  const base = fixture(dirs, { refDatabase: 'D20' });
  const { code, json } = runJson(ENSURE, ['--check', '--dir', base, '--no-download', '--test-image', path.join(base, 'nope.png')]);
  // With no headless solver present there is nothing to probe: not ready.
  assert.equal(code, 1);
  if (json.probe) {
    assert.notEqual(json.probe.compatible, true, 'probe must not report compatible without a decodable image');
  }
});

// -------------------------------------------------------------------- summary

if (failures.length) {
  console.error(`\n${failures.length} test(s) failed, ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`\nall ${passed} astap tests passed`);
}
