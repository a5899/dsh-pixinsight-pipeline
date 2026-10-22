#!/usr/bin/env node
// ensure-astap.mjs — install and verify a HEADLESS ASTAP solver plus its star catalog.
//
// ── Why this is not the obvious implementation ────────────────────────────────
// The regular GUI `astap.exe` cannot be driven from a script. Measured on this machine
// (2026-10-22): every invocation that also asks for output (`-o <file>`, `-tofits`,
// `-update`) opens the GUI window and blocks forever — two runs each sat at ~0.2 s CPU
// for 20+ minutes with a live `astap` window, and had to be killed by hand. A bare
// `astap.exe -log -fov 1.0 <image>` does exit 0 but produces no verifiable result.
// ASTAP therefore ships a separate `astap_cli` ("Barebone command-line solver ... No
// pop-up notifier") for automation. THIS script installs that, not the GUI one.
//
// ── What it can and cannot do automatically ───────────────────────────────────
// CAN (fully automatic):
//   - download a headless solver binary from GitHub raw (reachable without auth)
//   - place it next to the catalog, configure astap.cfg (ref_database), verify coherence
//   - detect an existing catalog and reuse it; detect the GUI-only case and warn
// CANNOT (blocked upstream, handled by an explicit fallback):
//   - the official ASTAP release downloads on sourceforge.net sit behind a Cloudflare
//     "Just a moment..." challenge. curl and PowerShell both receive the HTML challenge
//     page, not the zip. No amount of UA/referer/mirror juggling fixes that, so this
//     script never pretends to have solved it: it prints the exact URL and command for
//     the user, and re-verifies afterwards.
//   - the D-series catalog installers are likewise on sourceforge (same challenge).
//
// Usage:
//   node ensure-astap.mjs                 # detect -> install solver -> configure -> verify
//   node ensure-astap.mjs --check         # report only, never write or download
//   node ensure-astap.mjs --json
//   node ensure-astap.mjs --dir <astap dir>       # target directory (default %LOCALAPPDATA%\astap)
//   node ensure-astap.mjs --catalog-dir <dir>     # reuse a catalog that lives elsewhere
//   node ensure-astap.mjs --no-download           # never touch the network
//
// Exit codes: 0 usable, 1 not usable (--check or failed install), 2 bad arguments.
//
// ── Star catalog compatibility (learned the hard way) ─────────────────────────
// Old headless builds (e.g. the 2021 CLI-0.9.581 on GitHub) only understand the legacy
// h17/h18/v17 catalog and report "No star database found" against a modern D20 set.
// Modern D-series (D05/D20/D50/D80) all share the `.1476` tile suffix, so the suffix can
// never identify a database — only the file prefix (`d20_0101.1476`) can. The verifier
// below checks the prefix and refuses to claim success on a suffix match alone.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Headless solver acquisition. Resolution order:
//   1. bundled in the plugin   <pkg>/lib/pixinsight-mcp/vendor/{astap_cli.exe,astap_setup.exe}
//   2. the project's own site  https://www.hnsky.org/astap_setup.exe  (no Cloudflare)
//   3. sourceforge — NOT used: Cloudflare challenge blocks scripts entirely.
// The bundled setup is an Inno Setup package, so astap_cli.exe can be extracted by running
// it silently into a scratch dir (/VERYSILENT /DIR=...), never by driving a GUI.
const INSTALLER_URL = 'https://www.hnsky.org/astap_setup.exe';
const INSTALLER_FALLBACKS = ['https://www.hnsky.org/astap.zip'];

// Star catalog is ~400 MB and compresses to ~390 MB (the tiles are already compressed), so
// it cannot live in git or npm. It ships as a GitHub Release asset instead.
const CATALOG_RELEASE_REPO = 'a5899/dsh-pixinsight-pipeline';
const CATALOG_ASSET = 'astap-d20-catalog.zip';

const CATALOG_PAGE = 'https://www.hnsky.org/astap.htm';

/** Directory holding the files that ship with this plugin (vendor/ next to scripts/). */
function vendorDir() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'vendor');
}
const CLI_RELEASES = 'https://www.hnsky.org/astap.htm#beta_version';

/**
 * Install the modern headless solver by running the official Inno Setup installer
 * silently into a scratch directory and copying `astap_cli.exe` out of it.
 * Silent switches: /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /DIR=<tmp>
 * Nothing is installed system-wide; the scratch dir is deleted afterwards.
 */
async function installHeadlessFromOfficialInstaller(installDir) {
  const vdir = vendorDir();
  const dest = path.join(installDir, 'astap_cli.exe');

  // 1. a ready-to-use headless binary shipped with the plugin
  const bundledCli = path.join(vdir, 'astap_cli.exe');
  if (fs.existsSync(bundledCli)) {
    fs.mkdirSync(installDir, { recursive: true });
    fs.copyFileSync(bundledCli, dest);
    return { ok: true, bytes: fs.statSync(dest).size, dest, version: readSolverVersion(dest), from: 'bundled astap_cli.exe' };
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'astap-setup-'));
  const setup = path.join(scratch, 'astap_setup.exe');
  try {
    // 2. a bundled installer, 3. the project site
    let source = null;
    const bundledSetup = path.join(vdir, 'astap_setup.exe');
    if (fs.existsSync(bundledSetup)) {
      fs.copyFileSync(bundledSetup, setup);
      source = 'bundled astap_setup.exe';
    } else {
      for (const url of [INSTALLER_URL, ...INSTALLER_FALLBACKS]) {
        const r = await download(url, setup);
        if (r.ok) { source = url; break; }
        if (fs.existsSync(setup)) fs.unlinkSync(setup);
      }
    }
    if (!source) {
      return { ok: false, error: 'no bundled installer and hnsky.org download failed' };
    }

    const target = path.join(scratch, 'app');
    const run = spawnSync(
      setup,
      ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', `/DIR=${target}`],
      { timeout: 300000, windowsHide: true, encoding: 'utf8' },
    );
    const cli = path.join(target, 'astap_cli.exe');
    if (!fs.existsSync(cli)) {
      return { ok: false, error: `installer produced no astap_cli.exe (exit ${run.status})` };
    }
    fs.mkdirSync(installDir, { recursive: true });
    fs.copyFileSync(cli, dest);
    return { ok: true, bytes: fs.statSync(dest).size, dest, version: readSolverVersion(dest), from: source };
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Ask the headless solver for its version (it prints it and exits; no window). */
function readSolverVersion(binary) {
  try {
    const out = spawnSync(binary, [], { timeout: 15000, encoding: 'utf8', windowsHide: true });
    const m = /solver version (\d{4}\.\d{2}\.\d{2})/i.exec(`${out.stdout || ''}${out.stderr || ''}`);
    return m ? m[1] : null;
  } catch { return null; }
}

function parseArgs(argv) {
  const a = { check: false, json: false, dir: null, catalogDir: null, noDownload: false };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--check') a.check = true;
    else if (v === '--json') a.json = true;
    else if (v === '--no-download') a.noDownload = true;
    else if (v === '--dir') a.dir = argv[++i];
    else if (v === '--catalog-dir') a.catalogDir = argv[++i];
    else if (v === '--test-image') a.testImage = argv[++i];
    else if (v === '--help' || v === '-h') a.help = true;
  }
  return a;
}

function defaultInstallDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), 'astap');
  }
  return path.join(os.homedir(), '.astap');
}

/** Group catalog tiles by real prefix (d20, h18, v17...). */
function scanCatalog(dir) {
  const families = {};
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return families;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = /^([a-z]{1,2}\d{2})_\d+\.(14\d\d|1476|1477|2900|2300)$/i.exec(e.name);
    if (!m) continue;
    const code = m[1].toUpperCase();
    families[code] ??= { code, suffix: `.${m[2]}`, tiles: 0, generation: /^[HV]/.test(code) ? 'legacy' : 'modern' };
    families[code].tiles += 1;
  }
  return families;
}

function pickCatalog(families) {
  const list = Object.values(families).sort((a, b) => {
    // modern before legacy, then larger code (deeper coverage)
    if (a.generation !== b.generation) return a.generation === 'modern' ? -1 : 1;
    return b.code.localeCompare(a.code);
  });
  return list[0] || null;
}

function readCfg(file) {
  const map = {};
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=(.*)$/.exec(line);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

function writeCfgKey(file, key, value) {
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[main]\n';
  const re = new RegExp(`^(${key}\\s*=).*$`, 'm');
  let next;
  if (re.test(original)) next = original.replace(re, `$1${value}`);
  else if (/^\[main\]/m.test(original)) next = original.replace(/^(\[main\][^\n]*\n)/m, `$1${key}=${value}\n`);
  else next = `${original}\n${key}=${value}\n`;
  if (next === original) return false;
  if (fs.existsSync(file)) {
    const backup = `${file}.bak-ensure-astap`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, next);
  return true;
}

function findHeadlessBinary(dir) {
  if (!dir) return null;
  for (const n of ['astap_cli.exe', 'astap_cli', 'astap-cli.exe', 'astap-cli']) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findGuiBinary(dir) {
  if (!dir) return null;
  for (const n of ['astap.exe', 'astap']) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Download to a file. Returns {ok, bytes, error}. Never throws. */
async function download(url, dest) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'dsh-pixinsight-pipeline' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    // A Cloudflare challenge or an error page is HTML, never a PE binary.
    if (buf.length < 10000 || (buf[0] === 0x3c && buf[1] === 0x21)) {
      return { ok: false, error: `not a binary (${buf.length} bytes, looks like an HTML page)` };
    }
    fs.writeFileSync(dest, buf);
    return { ok: true, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

const args = parseArgs(process.argv);
if (args.help) {
  console.error('usage: node ensure-astap.mjs [--check] [--json] [--dir <path>] [--catalog-dir <path>] [--no-download]');
  process.exit(2);
}

const installDir = path.resolve(args.dir || defaultInstallDir());
const catalogDir = path.resolve(args.catalogDir || installDir);

const report = {
  ok: false,
  installDir,
  catalogDir,
  guiBinary: findGuiBinary(installDir),
  headlessBinary: findHeadlessBinary(installDir),
  catalog: null,
  configPath: null,
  configuredDatabase: null,
  problems: [],
  steps: [],
  needsUserAction: null,
};

// ── 1. catalog ───────────────────────────────────────────────────────────────
let families = scanCatalog(catalogDir);
let picked = pickCatalog(families);

// No catalog on disk: fetch the release asset (≈400 MB, deliberately not in git/npm).
if (!picked && !args.check && !args.noDownload && args.allowCatalogDownload !== false) {
  const url = `https://github.com/${CATALOG_RELEASE_REPO}/releases/latest/download/${CATALOG_ASSET}`;
  const zipPath = path.join(os.tmpdir(), `astap-catalog-${Date.now()}.zip`);
  const r = await download(url, zipPath);
  if (r.ok) {
    try {
      // Extract with the platform's own zip support (tar.exe ships with Windows 10+).
      fs.mkdirSync(catalogDir, { recursive: true });
      const un = spawnSync('tar', ['-xf', zipPath, '-C', catalogDir], { timeout: 600000, windowsHide: true, encoding: 'utf8' });
      if (un.status === 0) {
        report.steps.push(`catalog: downloaded ${CATALOG_ASSET} (${Math.round(r.bytes / 1048576)} MiB) from the release`);
        families = scanCatalog(catalogDir);
        picked = pickCatalog(families);
      } else {
        report.problems.push(`catalog extract failed: ${(un.stderr || '').trim() || `tar exit ${un.status}`}`);
      }
    } finally {
      try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
    }
  } else {
    report.problems.push(`catalog download failed: ${r.error}`);
    report.catalogDownloadUrl = url;
  }
}

if (picked) {
  report.catalog = { code: picked.code, tiles: picked.tiles, suffix: picked.suffix, generation: picked.generation };
  report.steps.push(`catalog: ${picked.code} (${picked.tiles} tiles, ${picked.generation})`);
} else if (report.problems.length === 0) {
  report.problems.push(`no star catalog tiles in ${catalogDir}`);
  report.catalogDownloadUrl = `https://github.com/${CATALOG_RELEASE_REPO}/releases/latest/download/${CATALOG_ASSET}`;
}

// ── 2. headless solver ───────────────────────────────────────────────────────
if (!report.headlessBinary && !args.check && !args.noDownload) {
  fs.mkdirSync(installDir, { recursive: true });
  const r = await installHeadlessFromOfficialInstaller(installDir);
  if (r.ok) {
    report.headlessBinary = r.dest;
    report.installedByThisRun = true;
    report.steps.push(
      `installed headless solver ${r.version || ''} from ${r.from} (${Math.round(r.bytes / 1024)} KiB)`.replace(/\s+/g, ' '),
    );
  } else {
    report.problems.push(`headless solver install failed: ${r.error}`);
  }
}

// ── 3. config coherence ──────────────────────────────────────────────────────
const cfgPath = path.join(catalogDir, 'astap.cfg');
report.configPath = fs.existsSync(cfgPath) ? cfgPath : null;
if (picked) {
  const cfg = readCfg(cfgPath);
  const configured = (cfg.ref_database || '').trim() || null;
  report.configuredDatabase = configured;
  const matches =
    configured &&
    (configured.toUpperCase() === picked.code ||
      // D-series share .1476, so any D-code is coherent with a D-family catalog
      (picked.generation === 'modern' && configured.toUpperCase().startsWith('D') && picked.code.startsWith('D')));
  if (!matches) {
    report.problems.push(`astap.cfg ref_database=${configured || '(empty)'} does not match installed ${picked.code} (${picked.suffix})`);
    if (!args.check) {
      if (writeCfgKey(cfgPath, 'ref_database', picked.code)) {
        report.configuredDatabase = picked.code;
        report.steps.push(`set ref_database=${picked.code} (backup: astap.cfg.bak-ensure-astap)`);
        report.problems.pop();
      }
    }
  } else {
    report.steps.push(`config: ref_database=${configured} (matches catalog)`);
  }
}

// ── 4. prove the solver can actually read the catalog ────────────────────────
// A probe needs a REAL image: given a missing file the solver complains about the file and
// never reaches the catalog check, which reads as "compatible" when it is not.
/** Locate a decodable image to probe with: explicit arg, else the deliverables folder. */
function findTestImage(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const roots = [
    path.join(os.homedir(), 'Desktop', '天文成图'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), '.pixinsight-mcp', 'deliverables'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    let depth = 0;
    while (stack.length && depth < 300) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (/\.(png|jpg|jpeg|tif|tiff|fits|fit)$/i.test(e.name)) {
          try { if (fs.statSync(full).size > 200 * 1024) return full; } catch { /* ignore */ }
        }
      }
      depth += 1;
    }
  }
  return null;
}

// A probe needs a REAL, decodable image. Two traps found the hard way:
//   1. a missing file      -> "accessing the file!" -> never reaches the catalog check
//   2. a hand-built PNG    -> "Error reading image file" -> same short-circuit
// Both read as "compatible" if you only look for the absence of a catalog error, so the
// probe must (a) use an image the solver can decode and (b) require positive evidence that
// the catalog was consulted, not merely the absence of a complaint.
function probeSolver(binary, catDir, testImage) {
  if (!testImage || !fs.existsSync(testImage)) {
    return { compatible: null, detail: 'no decodable test image found (pass --test-image)' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astap-probe-'));
  try {
    const r = spawnSync(
      binary,
      ['-f', testImage, '-fov', '1.0', '-o', path.join(tmp, 'p'), '-d', catDir, '-log'],
      { timeout: 120000, encoding: 'utf8', windowsHide: true },
    );
    // The binary must actually have RUN. A non-executable file, a wrong arch, or a crash
    // yields no output at all — and "no catalog error in empty output" must never be
    // mistaken for success (that false positive was observed while writing this file).
    if (r.error || (r.stdout === null && r.stderr === null) || (r.status === null && !r.stdout)) {
      return { compatible: null, detail: `solver could not be executed (${r.error?.code || 'no output'})` };
    }
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const iniPath = path.join(tmp, 'p.ini');
    const ini = fs.existsSync(iniPath) ? fs.readFileSync(iniPath, 'utf8') : '';
    if (!out.trim() && !ini.trim()) {
      return { compatible: null, detail: 'solver produced no output at all (probe inconclusive)' };
    }
    const noDb = /no star database found/i.test(out) || /no star database found/i.test(ini);
    const badImage = /error reading image file|accessing the file/i.test(out) || /error reading image file/i.test(ini);
    if (badImage) {
      return { compatible: null, detail: 'solver could not read the test image (probe inconclusive)', raw: out.trim().split(/\r?\n/).filter(Boolean).pop() || '' };
    }
    // Positive evidence required: the solver must name the database it loaded.
    const usedDb = /using star database\s+([A-Z]\d+)/i.exec(out);
    return {
      compatible: !noDb && Boolean(usedDb),
      detail: noDb
        ? 'solver reports no usable star database'
        : usedDb
          ? `solver loaded star database ${usedDb[1]} and attempted a solve`
          : 'solver ran but never reported loading a star database',
      raw: out.trim().split(/\r?\n/).filter(Boolean).pop() || '',
    };
  } catch (err) {
    return { compatible: null, detail: `probe failed: ${err?.message || err}` };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

if (report.headlessBinary && report.catalog) {
  const probeImage = findTestImage(args.testImage);
  report.probeImage = probeImage;
  report.probe = probeSolver(report.headlessBinary, catalogDir, probeImage);
  if (report.probe.compatible === false) {
    report.problems.push(
      `headless solver cannot read ${report.catalog.code} catalog — ${report.probe.detail}. ` +
      'The GitHub headless build is from 2021 and only supports legacy h17/h18/v17 catalogs.',
    );
    // A solver that cannot read the catalog is worse than no solver: it looks installed
    // and silently fails. Remove what this run installed so the state is not confusing.
    if (report.installedByThisRun) {
      try {
        fs.unlinkSync(report.headlessBinary);
        report.steps.push(`removed incompatible solver ${path.basename(report.headlessBinary)} (installed this run)`);
        report.headlessBinary = null;
      } catch { /* leave it; the problem is already reported */ }
    }
    report.needsUserAction ??= {
      what: 'a headless solver that understands D-series catalogs',
      why: 'the automatically fetched build predates D-series support',
      manualUrl: CLI_RELEASES,
      manualSteps: [
        'Open ' + CATALOG_PAGE + ' (downloads sit behind a Cloudflare challenge; a browser is required).',
        'Download "astap_cli" for Windows 64-bit — the current build reads D-series catalogs.',
        'Unzip it into ' + installDir + ' as astap_cli.exe',
        'Re-run: node ensure-astap.mjs --check',
      ],
    };
  } else if (report.probe.compatible) {
    report.steps.push(`probe: solver accepts ${report.catalog.code} catalog`);
  } else {
    // Inconclusive is NOT success. Say so instead of reporting a green state we cannot back.
    report.problems.push(`compatibility unverified — ${report.probe.detail}`);
  }
}

// ── 5. verdict ───────────────────────────────────────────────────────────────
const hasSolver = Boolean(report.headlessBinary);
const hasCatalog = Boolean(report.catalog);
report.ok = hasSolver && hasCatalog && report.problems.length === 0;

if (!hasSolver) {
  report.needsUserAction = {
    what: 'headless ASTAP solver',
    why: 'the GUI astap.exe hangs any script that asks it to solve or convert',
    manualUrl: CLI_RELEASES,
    manualSteps: [
      'Open ' + CATALOG_PAGE + ' (downloads are behind a Cloudflare challenge, so a browser is required).',
      'Download "astap_cli" for Windows 64-bit (the barebone command-line solver).',
      'Unzip astap_cli.exe into ' + installDir,
      'Re-run: node ensure-astap.mjs --check',
    ],
  };
}
if (!hasCatalog) {
  report.needsUserAction ??= {
    what: 'ASTAP star catalog',
    manualUrl: CATALOG_PAGE,
    manualSteps: [
      'Open ' + CATALOG_PAGE,
      'Download one catalog for your typical FOV (D20 ≈ 400 MB covers most amateur setups).',
      'Run its installer, or unzip the *.1476 tiles into ' + catalogDir,
      'Re-run: node ensure-astap.mjs --check',
    ],
  };
}

report.summary = report.ok
  ? `ASTAP ready — solver ${path.basename(report.headlessBinary)} · catalog ${report.catalog.code} ` +
    `(${report.catalog.tiles} tiles) · ref_database=${report.configuredDatabase}`
  : `ASTAP not ready — ${[...report.problems, !hasSolver ? 'no headless solver' : null, !hasCatalog ? 'no catalog' : null]
      .filter(Boolean).join('; ')}`;

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(report.summary);
  for (const s of report.steps) console.log(`  ok      ${s}`);
  for (const p of report.problems) console.log(`  problem ${p}`);
  if (report.guiBinary && !report.headlessBinary) {
    console.log(`  note    GUI binary present at ${report.guiBinary} but it cannot be scripted`);
  }
  if (report.needsUserAction) {
    console.log(`  -- ${report.needsUserAction.what}: manual step required --`);
    for (const s of report.needsUserAction.manualSteps) console.log(`     ${s}`);
  }
}

process.exit(report.ok ? 0 : 1);
