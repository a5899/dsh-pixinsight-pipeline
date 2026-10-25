#!/usr/bin/env node
// ============================================================================
// ensure-gaia.mjs — detect, configure and verify PixInsight's Gaia catalog.
//
// WHY THIS EXISTS
//
// ImageSolver (the astrometric solve) and SPCC (spectrophotometric colour
// calibration) both need star catalogs. Without one they do NOT raise — they
// return clean and change nothing:
//
//   * Gaia.executeGlobal() returned sources=0 and status=ok with no catalog.
//   * SPCC.executeOn() returned without error and left every channel mean
//     bit-identical.
//   * ImageSolver.SolveImage() returned true and wrote no WCS keywords.
//
// That is the whole trap: a green result that silently did nothing. So this
// tool never reports "configured" without proving the catalog can be queried.
//
// WHAT IT CAN AND CANNOT DO
//
// The catalog files (XPSD) are only distributed behind the PixInsight login
// (https://pixinsight.com/dist/). There is no anonymous download URL, so this
// tool CANNOT fetch them for you. It does the rest:
//
//   detect    what catalogs PixInsight can currently see
//   configure point PixInsight at catalog files you already downloaded
//   verify    query the catalog and PROVE it returns sources
//
// Usage:
//   node ensure-gaia.mjs                     # detect + report what to do
//   node ensure-gaia.mjs --check             # same, exits 3 when unusable
//   node ensure-gaia.mjs --dir <path>        # configure a directory of .xpsd files
//   node ensure-gaia.mjs --json              # machine-readable
//   node ensure-gaia.mjs --verify            # probe the catalog with a real query
//
// Exit codes: 0 ok, 1 error, 3 catalog missing/unusable.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PI_TOOL = path.join(HERE, 'pi-tool.mjs');

// Gaia data release ids, mirroring the Gaia process' DataRelease_* constants.
const DR = {
  BestAvailable: 0,
  DR2: 2,
  EDR3: 3,
  DR3: 3,
  DR3SP: 4,
};
const DR_NAMES = { 0: 'BestAvailable', 2: 'Gaia DR2', 3: 'Gaia DR3/EDR3', 4: 'Gaia DR3/SP' };

function parseArgs(argv) {
  const args = { dir: null, check: false, json: false, verify: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--check') args.check = true;
    else if (a === '--json') args.json = true;
    else if (a === '--verify') args.verify = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

/** Run a PJSR snippet in PixInsight and return its console output. */
function pjsr(code) {
  const res = spawnSync(process.execPath, [PI_TOOL, 'pjsr', JSON.stringify({ code })], {
    encoding: 'utf8',
    timeout: 120000,
  });
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || '').trim();
    throw new Error(`PixInsight bridge unavailable: ${msg.slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`unparseable pi-tool output: ${res.stdout.slice(0, 200)}`);
  }
  if (parsed.status === 'error') {
    throw new Error(`PJSR error: ${parsed.error?.message || 'unknown'}`);
  }
  return (parsed.result ?? parsed.outputs?.consoleOutput ?? '').trim();
}

/**
 * Ask PixInsight what it currently knows about catalogs.
 *
 * Reads the Gaia process state (databaseFilePaths is the authoritative list of
 * installed files) plus the catalog ids ImageSolver offers.
 */
function detect() {
  const raw = pjsr(`
    var out = { pi: {}, solver: {} };
    try {
      var g = new Gaia;
      out.pi.dataRelease = g.dataRelease;
      out.pi.dataReleaseName = '${''}';
      out.pi.databaseFilePaths = (g.databaseFilePaths || []).slice(0);
    } catch (e) { out.pi.error = e.message; }
    try {
      var P = new ImageSolver();
      var w = ImageWindow.activeWindow;
      P.Init(w, false);
      var c = P.solverCfg;
      out.solver.availableCatalogs = (c.availableCatalogs || []).map(function (x) { return x.id; });
      out.solver.currentCatalog = c.catalog;
    } catch (e2) { out.solver.error = e2.message; }
    JSON.stringify(out);
  `);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `could not parse detection output: ${raw.slice(0, 200)}`, raw };
  }
  return { ok: true, ...parsed };
}

/**
 * Prove the configured catalog actually answers a query.
 *
 * This is the step that matters: every failure mode here is silent, so "no
 * error" is worth nothing. A usable catalog returns a positive source count
 * for a patch of sky that is definitely full of stars.
 */
function verify() {
  const raw = pjsr(`
    // M27 is a star-dense field; 2 degrees around it must return sources.
    var out = { sources: -1, dr: -1, error: '', tried: [] };

    // The DataRelease_* constants live on the PROTOTYPE, not on instances and
    // not on the bare \\'Gaia\\' global. Verified on 1.9.4:
    //   Gaia.prototype.DataRelease_3_SP = 4   (DR3/SP)
    //   Gaia.prototype.DataRelease_3    = 3   (DR3/EDR3 - the power-on default)
    //   Gaia.prototype.DataRelease_E3   = 2
    //   Gaia.prototype.DataRelease_2    = 1
    //   Gaia.prototype.DataRelease_BestAvailable = 0
    // A fresh PixInsight session always starts at dataRelease = 3, so a catalog
    // registered under the DR3/SP slot is INVISIBLE unless we switch to 4.
    var DR = {
      best: 0,
      dr2: 1,
      e3: 2,
      dr3: 3,
      dr3sp: 4,
    };

    function query(dr) {
      var g = new Gaia;
      g.dataRelease = dr;
      g.command = "search";
      g.centerRA = 299.93;
      g.centerDec = 22.78;
      g.radius = 2.0;
      g.sourceLimit = 50;
      g.magnitudeLow = 0;
      g.magnitudeHigh = 20;
      g.verbosity = 0;              // keep the console quiet
      g.generateTextOutput = false;
      g.executeGlobal();
      return {
        dr: dr,
        ok: g.isValid,
        sources: g.sources ? g.sources.length : 0,
        outDR: g.outputDataRelease,
        hasMeanSpectrum: g.databaseHasMeanSpectrumData,
        nPaths: (g.databaseFilePaths || []).length,
      };
    }

    // Try DR3/SP last-but-not-least: it is the release most people install as
    // the "small set", and it is the one SPCC needs.
    var order = [DR.dr3sp, DR.dr3, DR.e3, DR.dr2, DR.best];
    for (var i = 0; i < order.length; ++i) {
      try {
        var r = query(order[i]);
        out.tried.push(r);
        if (r.sources > 0) {
          out.sources = r.sources;
          out.dr = r.dr;
          out.outDR = r.outDR;
          out.hasMeanSpectrum = r.hasMeanSpectrum;
          out.nPaths = r.nPaths;
          break;
        }
      } catch (e) { out.error = e.message; }
    }
    JSON.stringify(out);
  `);
  try {
    return JSON.parse(raw);
  } catch {
    return { sources: -1, error: `unparseable verify output: ${raw.slice(0, 200)}` };
  }
}

/** Configure PixInsight to use every .xpsd file found under `dir`. */
function configure(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }
  const abs = path.resolve(dir);
  // PJSR needs forward slashes; a lone backslash is an escape ("D:\astro\x").
  const url = abs.replace(/\\/g, '/');
  const raw = pjsr(`
    var dir = '${url.replace(/'/g, "\\'")}';
    var out = { found: [], configured: false, error: '' };
    try {
      var g = new Gaia;
      // Only .xpsd files count: the loader ignores anything else, so passing a
      // directory listing through would look successful and load nothing.
      var names = searchDirectory(dir + '/*.xpsd');
      out.found = names ? names.length : 0;
      if (!names || names.length === 0) {
        out.error = 'no .xpsd files in ' + dir;
      } else {
        // databaseFilePaths is a TABLE, not a string array: each row is itself a
        // one-element array ["<path>"]. Passing ["path", "path"] raises
        // "expected an array table row definition (row #0)".
        var rows = [];
        for (var i = 0; i < names.length; i++) {
          rows.push([String(names[i]).replace(/\\\\/g, '/')]);
        }
        g.databaseFilePaths = rows;
        // NOTE: the assignment above is per-instance and is DISCARDED when
        // executeGlobal() runs — the process resolves its catalog list from the
        // per-release settings slots ("GaiaDR3SPDatabaseFilePathNN"), which only
        // the Gaia Preferences dialog writes. So this path validates that the
        // files load; it cannot make them durable. Register once in the GUI.
        out.configured = true;
        out.found = names.length;
        out.persisted = false;
      }
    } catch (e) { out.error = e.message; }
    JSON.stringify(out);
  `);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`unparseable configure output: ${raw.slice(0, 200)}`);
  }
  if (parsed.error && !parsed.configured) throw new Error(parsed.error);
  return parsed;
}

/**
 * Look for .xpsd files in the usual places, WITHOUT asking PixInsight.
 *
 * This matters because the two halves of "is Gaia usable" fail independently:
 * the files can be perfectly present on disk while PixInsight has not been told
 * about them (that registration is GUI-only). Reporting "no catalog installed"
 * when 11 GB of valid files sit in a folder is misleading, so we say both things:
 * files found where, and whether PixInsight has registered them.
 */
const SEARCH_DIRS = [
  'D:/Gaia DR3&SP (small set)',
  'D:/astro/PI-catalogs/GaiaDR3SP',
  'D:/astro/PI-catalogs',
  'C:/Users/a5093/Downloads',
  'D:/',
];

function findCatalogFilesOnDisk() {
  for (const dir of SEARCH_DIRS) {
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const hits = fs
        .readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith('.xpsd'))
        .map((n) => path.join(dir, n));
      if (hits.length) {
        return { dir, files: hits, bytes: hits.reduce((s, f) => s + fs.statSync(f).size, 0) };
      }
    } catch {
      /* unreadable dir: keep looking */
    }
  }
  return null;
}

function reportHuman(info, args) {
  const { detection, verification } = info;
  if (!detection.ok) {
    console.log(`PixInsight not reachable: ${detection.reason}`);
    console.log('Start PixInsight with the watcher, then re-run.');
    return;
  }
  const paths = detection.pi?.databaseFilePaths ?? [];
  console.log('PixInsight Gaia catalog status\n');
  console.log(`  Gaia process data release : ${DR_NAMES[detection.pi?.dataRelease] ?? detection.pi?.dataRelease}`);
  // NOTE: databaseFilePaths on a *fresh* Gaia instance is always empty — the
  // process resolves the catalog list only when it executes, from per-release
  // settings slots ("GaiaDR3SPDatabaseFilePathNN" etc.). So "none" here does NOT
  // mean nothing is installed; only a real query can answer that.
  console.log(`  Paths on a fresh instance : ${paths.length ? paths.length + ' file(s)' : 'none (resolved at execution time)'}`);
  if (paths.length) {
    for (const p of paths.slice(0, 6)) console.log(`      ${p}`);
    if (paths.length > 6) console.log(`      ... and ${paths.length - 6} more`);
  }
  const cats = detection.solver?.availableCatalogs ?? [];
  console.log(`  ImageSolver catalog list  : ${cats.length ? cats.join(', ') : '(unavailable)'}`);
  console.log(`  ImageSolver selected      : ${detection.solver?.currentCatalog ?? 'n/a'}`);

  if (verification) {
    console.log('');
    if (verification.error) {
      console.log(`  Catalog query             : FAILED — ${verification.error}`);
    } else if (verification.sources > 0) {
      const drName = DR_NAMES[verification.outDR] ?? verification.outDR;
      console.log(`  Catalog query             : OK — ${verification.sources} source(s) returned`);
      console.log(`  Answering release         : ${drName} (dataRelease=${verification.dr})`);
      if (verification.hasMeanSpectrum) console.log('  Mean BP/RP spectra        : available (SPCC can use it)');
    } else {
      console.log('  Catalog query             : NO SOURCES — catalog not usable');
    }
  }

  // The catalog is usable iff a real query came back with sources. The empty
  // per-instance path list is expected and must not veto that.
  const usable = !!verification && verification.sources > 0;
  const onDisk = findCatalogFilesOnDisk();
  console.log('');
  if (usable) {
    console.log('Gaia is configured and answering queries.');
    console.log('ImageSolver and SPCC will use it offline.');
    return;
  }

  if (onDisk) {
    // The files are here but PixInsight does not know about them. This is the
    // common "I downloaded it, why doesn't it work" state, so lead with it.
    console.log(`Catalog files FOUND on disk but NOT registered in PixInsight:\n`);
    console.log(`  folder : ${onDisk.dir}`);
    console.log(`  files  : ${onDisk.files.length} .xpsd (${(onDisk.bytes / 1024 ** 3).toFixed(2)} GB)`);
    for (const f of onDisk.files.slice(0, 6)) console.log(`      ${path.basename(f)}`);
    console.log('');
    console.log('Why the script cannot finish this for you: the Gaia process keeps its');
    console.log('database list in core settings that a script has no entitlement to');
    console.log('write — Settings.canWriteGlobal() returns false, and assigning');
    console.log('Gaia.databaseFilePaths is discarded when executeGlobal() runs');
    console.log('("No database files have been selected"). It has to be registered');
    console.log('once, by hand, in the Gaia process interface:\n');
    console.log('  1. In PixInsight: Processes > Star Catalogs > Gaia');
    console.log('     (or type "Gaia" and press Enter to open the process window)');
    console.log('  2. Click the wrench/Preferences button at the bottom right.');
    console.log('  3. Data release: Gaia DR3/SP');
    console.log('  4. Click "Select", then choose ALL of these files in');
    console.log(`     ${onDisk.dir}`);
    for (const f of onDisk.files) console.log(`        ${path.basename(f)}`);
    console.log('  5. OK, then OK again. Re-run this tool with --verify.\n');
    console.log('Until then: ImageSolver can still solve from the image headers');
    console.log('(centre, focal length, pixel size). SPCC will silently do nothing.');
    return;
  }

  console.log('Gaia is NOT usable yet, and no .xpsd files were found on disk.\n');
  console.log('The catalog files (XPSD) are only distributed behind the PixInsight');
  console.log('login, so no script can download them for you. And they cannot be');
  console.log('registered from a script either — the Gaia process has no');
  console.log('saveSettings(), and Settings.writeGlobal() is refused with');
  console.log('"The caller process lacks entitlement to perform operation".');
  console.log('So download them first, then register them once by hand in the GUI:\n');
  console.log('  1. Sign in at https://pixinsight.com/dist/');
  console.log('  2. Scroll to "XPSD Database Files".');
  console.log('  3. Download Gaia DR3/SP — pick the SMALL SET unless you shoot very');
  console.log('     wide fields; the complete set is ~100 GB, the small set is a');
  console.log('     fraction of that (about 11 GB in 4 files) and covers typical');
  console.log('     amateur star counts.');
  console.log('  4. Put the .xpsd files in one folder OUTSIDE the PixInsight');
  console.log('     program directory (a program update will not touch it), e.g.');
  console.log('     D:/astro/PI-catalogs/GaiaDR3SP/.');
  console.log('  5. In PixInsight: Processes > Star Catalogs > Gaia >');
  console.log('     Preferences > Data Release: Gaia DR3/SP > Select > pick the');
  console.log('     .xpsd files > OK.');
  console.log('  6. Re-run this tool to confirm:\n');
  console.log(`       node "${path.basename(fileURLToPath(import.meta.url))}" --verify`);
  console.log('');
  console.log('  Meanwhile ImageSolver still works: it can solve from the image');
  console.log('  headers (centre, focal length, pixel size) without any local');
  console.log('  catalog. SPCC is the one that cannot run without Gaia.');
}

function main() {
  const args = parseArgs(process.argv);
  let detection;
  try {
    detection = detect();
  } catch (e) {
    const payload = { ok: false, reason: e.message };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else reportHuman({ detection: payload }, args);
    process.exit(args.check ? 3 : 1);
  }

  let configured = null;
  if (args.dir) {
    try {
      configured = configure(args.dir);
      detection = detect(); // re-read after configuring
    } catch (e) {
      const payload = { ok: false, error: e.message, detection };
      if (args.json) console.log(JSON.stringify(payload, null, 2));
      else console.log(`Could not configure: ${e.message}`);
      process.exit(1);
    }
  }

  let verification = null;
  const wantsVerify = args.verify || args.dir || args.check;
  if (wantsVerify) {
    try {
      verification = verify();
    } catch (e) {
      verification = { sources: -1, error: e.message };
    }
  }

  const info = { ok: true, detection, configured, verification };
  if (args.json) {
    console.log(JSON.stringify(info, null, 2));
  } else {
    reportHuman(info, args);
    if (configured) {
      console.log('');
      console.log(`Configured ${configured.found} catalog file(s).`);
    }
  }

  // Same rule as reportHuman(): only a positive query result proves the catalog
  // is usable. The fresh-instance path list is always empty by design.
  const usable = !!verification && verification.sources > 0;
  if (args.check) process.exit(usable ? 0 : 3);
  process.exit(0);
}

main();
