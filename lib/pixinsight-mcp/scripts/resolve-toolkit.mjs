#!/usr/bin/env node
// resolve-toolkit.mjs — find the pixinsight-mcp toolkit on THIS machine.
//
// The same package ships to two kinds of installs:
//   A) installed   -> toolkit at %DSH_HOME%\pixinsight-mcp  (install-*.ps1 deploy it there)
//   B) source tree -> toolkit at <workspace>\tools\pixinsight-mcp
//
// Hardcoding either one breaks the other, so every doc command runs through this
// resolver instead. It prints the toolkit root (or a subpath) and exits non-zero
// when nothing usable is found, which is far better than a command that silently
// points at a directory that does not exist.
//
// Usage:
//   node resolve-toolkit.mjs                     # print toolkit root
//   node resolve-toolkit.mjs --sub scripts/pi-tool.mjs   # print a file inside it
//   node resolve-toolkit.mjs --json              # machine-readable, lists all probed
//   node resolve-toolkit.mjs --check             # verify pi-tool + watcher + wbpp exist
//
// Exit codes: 0 found, 1 not found, 2 bad arguments.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Files that must exist for a directory to count as a toolkit root.
const FINGERPRINT = [
  path.join('scripts', 'pi-tool.mjs'),
  path.join('pjsr', 'pixinsight-mcp-watcher.js'),
];

function isToolkit(dir) {
  if (!dir) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return FINGERPRINT.every((rel) => fs.existsSync(path.join(dir, rel)));
}

function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), '.dsh');
}

/**
 * Candidate roots in priority order.
 * 1. explicit env override
 * 2. installed location (%DSH_HOME%\pixinsight-mcp)
 * 3. source tree, walked up from this script (…/packages/<pkg>/lib/pixinsight-mcp
 *    or …/tools/pixinsight-mcp -> workspace root)
 */
function candidates() {
  const out = [];
  const push = (dir, why) => {
    if (!dir) return;
    const abs = path.resolve(dir);
    if (!out.some((c) => c.dir === abs)) out.push({ dir: abs, why });
  };

  push(process.env.PIXINSIGHT_MCP_TOOLKIT, 'env PIXINSIGHT_MCP_TOOLKIT');
  push(path.join(dshHome(), 'pixinsight-mcp'), 'installed (%DSH_HOME%)');

  // Walk up from this file looking for a sibling tools/pixinsight-mcp.
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    push(path.join(dir, 'tools', 'pixinsight-mcp'), `source tree (${path.join(dir, 'tools')})`);
    // Also handle the package's own bundled copy: <pkg>/lib/pixinsight-mcp
    push(path.join(dir, 'lib', 'pixinsight-mcp'), 'package bundle (lib/pixinsight-mcp)');
  }

  // Last resort: the package this script ships in.
  push(path.resolve(HERE, '..'), 'this script\'s own package');

  return out;
}

function parseArgs(argv) {
  const args = { sub: null, json: false, check: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sub') args.sub = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--check') args.check = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.error('usage: node resolve-toolkit.mjs [--sub <relative path>] [--json|--check]');
  process.exit(2);
}

const probed = candidates();
const hit = probed.find((c) => isToolkit(c.dir));

if (args.check) {
  const checks = hit
    ? {
        toolkit: hit.dir,
        piTool: fs.existsSync(path.join(hit.dir, 'scripts', 'pi-tool.mjs')),
        watcher: fs.existsSync(path.join(hit.dir, 'pjsr', 'pixinsight-mcp-watcher.js')),
        wbppWrapper: fs.existsSync(path.join(hit.dir, 'run-wbpp.ps1')),
        findMasters: fs.existsSync(path.join(hit.dir, 'scripts', 'find-masters.mjs')),
        cleanWbpp: fs.existsSync(path.join(hit.dir, 'scripts', 'clean-wbpp-intermediates.mjs')),
      }
    : null;
  const ok = !!checks && Object.entries(checks).every(([k, v]) => k === 'toolkit' || v);
  console.log(JSON.stringify({ ok, source: hit?.why ?? null, checks, probed }, null, 2));
  process.exit(ok ? 0 : 1);
}

if (!hit) {
  const lines = ['pixinsight-mcp toolkit not found. Probed:'];
  for (const c of probed) lines.push(`  - ${c.dir}   (${c.why})`);
  lines.push('');
  lines.push('Fix: install it with one of the package installers, or point');
  lines.push('     PIXINSIGHT_MCP_TOOLKIT at the toolkit directory.');
  console.error(lines.join('\n'));
  process.exit(1);
}

const target = args.sub ? path.join(hit.dir, args.sub) : hit.dir;

if (args.json) {
  console.log(JSON.stringify({ ok: true, toolkit: hit.dir, source: hit.why, resolved: target, probed }, null, 2));
} else {
  console.log(target);
}

// A --sub path that does not exist is an error: the caller is about to run it.
if (args.sub && !fs.existsSync(target)) {
  console.error(`resolved toolkit is ${hit.dir}, but "${args.sub}" does not exist there.`);
  process.exit(1);
}
